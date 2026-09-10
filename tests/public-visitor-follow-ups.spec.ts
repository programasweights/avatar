import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";

// Run alone after deployment; every command goes through the real public API.
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/public-visitor-follow-ups.spec.ts --workers=1
test.skip(process.env.AVATAR_LIVE_PUBLIC !== "1", "Opt in to real public follow-up inference.");
test.describe.configure({ mode: "serial" });
test.use({
  viewport: { width: 1280, height: 960 },
  video: "on", // Playwright saves and attaches the recording to testInfo.
  launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"],
  },
});

type Record = { calls: unknown[]; samples: unknown[]; errors: string[] };
const evidence = new WeakMap<Page, Record>();
const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
const angle = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1,
  Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)) / (Math.hypot(...a) * Math.hypot(...b)),
));
const armJoints = (side: string) => ["clavicle", "shoulder", "elbow", "wrist"].map(joint => `${side}_${joint}`);

test.beforeEach(async ({ page }) => {
  test.setTimeout(600_000);
  const record: Record = { calls: [], samples: [], errors: [] };
  evidence.set(page, record);
  page.on("pageerror", error => record.errors.push(error.message));
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  url.pathname = "/gangnam";
  url.search = "?dbg=1&quality=low";
  await page.goto(url.href);
  await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion, undefined, { timeout: 90_000 });
  expect((await state(page)).character).toBe("gangnam");
  expect((await state(page)).program.dance.style).toBe("gangnam");
});

test.afterEach(async ({ page }, testInfo) => {
  const record = evidence.get(page)!;
  await testInfo.attach("public-commands-and-rendered-poses", {
    body: JSON.stringify(record, null, 2), contentType: "application/json",
  });
  if (!page.isClosed()) await screenshot(page, testInfo, "final-state");
  expect(record.errors).toEqual([]);
});

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function direct(page: Page, instruction: string, expected: string) {
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const responsePromise = page.waitForResponse(response => {
    const request = response.request();
    return request.method() === "POST"
      && ["/api/v1/avatar/direct", "/api/direct"].includes(new URL(response.url()).pathname)
      && request.postDataJSON().instruction === instruction;
  }, { timeout: 180_000 });
  const started = Date.now();
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const response = await responsePromise;
  const result = await response.json();
  evidence.get(page)!.calls.push({ instruction, status: response.status(), result, elapsedMs: Date.now() - started });
  expect(response.status()).toBe(200);
  expect(result.output).toBe(expected);
  await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled({ timeout: 180_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await state(page);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline), { timeout: 30_000 }).toEqual(compileMotion(current.program));
  return current;
}

async function sample(page: Page, time: number) {
  const value = await page.evaluate(time => {
    const studio = (window as any).__motionStudio, motion = (window as any).__motion;
    studio.seek(time);
    motion.seek(time);
    return { time, pose: motion.snapshot(), props: motion.rig.props.snapshot(), rootQuaternion: motion.rig.scene.quaternion.toArray() };
  }, time);
  evidence.get(page)!.samples.push(value);
  for (const joint of Object.values(value.pose) as any[])
    expect([...joint.position, ...joint.quaternion].every(Number.isFinite)).toBe(true);
  return value;
}

test("whole-arm freeze and restore select every arm joint while the dance keeps playing", async ({ page }, testInfo) => {
  const initial = await state(page);
  const feet = findNode(initial.program.root, "feet");
  expect(feet).toBeDefined();
  await sample(page, 1.3);
  const left = await direct(page, "Freeze your left arm.", "freeze left_arm");
  expect(left.frozen.flatMap((token: any) => token.targets).sort()).toEqual(armJoints("left").sort());
  expect(left.playing).toBe(true);
  expect(findNode(left.program.root, "feet")).toEqual(feet);
  await sample(page, 2.1);
  await screenshot(page, testInfo, "left-arm-frozen");

  const restored = await direct(page, "Let your left arm move again.", "restore left_arm");
  expect(restored.frozen).toEqual([]);
  expect(restored.program).toEqual(initial.program);

  const both = await direct(page, "Freeze both arms while keeping the dance going.", "freeze both_arms");
  expect(both.frozen.flatMap((token: any) => token.targets).sort()).toEqual([...armJoints("left"), ...armJoints("right")].sort());
  expect(both.playing).toBe(true);
  expect(findNode(both.program.root, "feet")).toEqual(feet);
  await sample(page, 2.1);
  await screenshot(page, testInfo, "both-arms-frozen");

  const allRestored = await direct(page, "Unfreeze both arms.", "restore both_arms");
  expect(allRestored.frozen).toEqual([]);
  expect(allRestored.program).toEqual(initial.program);
  expect(allRestored.playing).toBe(true);
});

test("making the coin roll faster retimes the current hand motion and its coin contacts", async ({ page }, testInfo) => {
  const original = await direct(page, "Roll a coin across your left knuckles.", "skill coin_roll left forward");
  const duration = compileMotion(original.program).duration;
  const progress = [0.2, 0.55, 0.9];
  const before = [];
  for (const fraction of progress) before.push(await sample(page, duration * fraction));

  const faster = await direct(page, "Make the coin roll faster.", "tempo_scale 1.25");
  const fasterDuration = compileMotion(faster.program).duration;
  expect(faster.program.bpm).toBeCloseTo(original.program.bpm * 1.25, 6);
  expect(fasterDuration).toBeCloseTo(duration / 1.25, 6);
  expect(faster.program.title).toBe(original.program.title);
  expect(faster.program.props).toEqual(original.program.props);
  expect(faster.focus).toBe(original.focus);
  for (const [index, fraction] of progress.entries()) {
    const after = await sample(page, fasterDuration * fraction);
    for (const target of Object.keys(before[index].pose)) {
      expect(distance(after.pose[target].position, before[index].pose[target].position), `${target} follows the same motion at the new tempo`).toBeLessThan(1e-5);
      expect(angle(after.pose[target].quaternion, before[index].pose[target].quaternion)).toBeLessThan(1e-5);
    }
    expect(Object.keys(after.props)).toEqual(Object.keys(before[index].props));
    expect(Object.keys(after.props).length).toBeGreaterThan(0);
    for (const id of Object.keys(after.props)) {
      expect(after.props[id].visible).toBe(true);
      expect(distance(after.props[id].position, before[index].props[id].position)).toBeLessThan(1e-5);
      expect(angle(after.props[id].quaternion, before[index].props[id].quaternion)).toBeLessThan(1e-5);
    }
  }
  await screenshot(page, testInfo, "faster-current-coin-roll");
});

test("an explicit half-turn rotates the rendered whole character instead of its head", async ({ page }, testInfo) => {
  const current = await direct(page, "Turn around 180 degrees.", "action turn_left 2");
  const timeline = compileMotion(current.program);
  expect(current.focus).toBe("body");
  expect(current.loop).toBe(false);
  expect(sampleTimeline(timeline, timeline.duration).find(value => value.target === "root" && value.channel === "rotation" && value.axis === "y")?.value).toBe(180);
  const start = await sample(page, 0), finish = await sample(page, timeline.duration);
  expect(angle(start.rootQuaternion, finish.rootQuaternion)).toBeCloseTo(Math.PI, 6);
  expect(angle(start.pose.head.quaternion, finish.pose.head.quaternion)).toBeLessThan(1e-5);
  expect(angle(start.pose.neck.quaternion, finish.pose.neck.quaternion)).toBeLessThan(1e-5);
  await expect(page.locator(".motion-caption p")).toHaveText("Turn around 180 degrees.");
  await screenshot(page, testInfo, "whole-body-half-turn");
});

test("a bare balance request and foot switch visibly trade supporting legs without changing Gangnam arms", async ({ page }, testInfo) => {
  const initial = await state(page);
  const arms = findNode(initial.program.root, "arms");
  expect(arms).toBeDefined();
  const left = await direct(page, "Balance on one foot.", "support left");
  expect(left.program.dance).toEqual({ style: "gangnam", support: "left" });
  expect(findNode(left.program.root, "arms")).toEqual(arms);
  const duration = compileMotion(left.program).duration;
  const progress = [0.1, 0.35, 0.6, 0.85];
  const leftSamples = [];
  for (const fraction of progress) {
    const current = await sample(page, duration * fraction);
    expect(current.pose.right_ankle.position[1] - current.pose.left_ankle.position[1]).toBeGreaterThan(0.3);
    expect(Math.abs(current.pose.hips.position[0] - current.pose.left_ankle.position[0])).toBeLessThan(0.06);
    leftSamples.push(current);
  }
  await screenshot(page, testInfo, "left-foot-support");

  const right = await direct(page, "Switch to the opposite foot.", "support other");
  expect(right.program.dance).toEqual({ style: "gangnam", support: "right" });
  expect(right.character).toBe(initial.character);
  expect(right.program.bpm).toBe(initial.program.bpm);
  expect(compileMotion(right.program).duration).toBeCloseTo(duration, 8);
  expect(findNode(right.program.root, "arms")).toEqual(arms);
  for (const [index, fraction] of progress.entries()) {
    const current = await sample(page, duration * fraction);
    expect(current.pose.left_ankle.position[1] - current.pose.right_ankle.position[1]).toBeGreaterThan(0.3);
    expect(Math.abs(current.pose.hips.position[0] - current.pose.right_ankle.position[0])).toBeLessThan(0.06);
    for (const joint of [...armJoints("left"), ...armJoints("right")])
      expect(angle(current.pose[joint].quaternion, leftSamples[index].pose[joint].quaternion), `${joint} keeps the same dance phase`).toBeLessThan(1e-5);
  }
  await expect(page.locator(".motion-caption p")).toHaveText("Switch to the opposite foot.");
  await screenshot(page, testInfo, "right-foot-support");
});
