import { expect, test, type Page } from "@playwright/test";
import { Quaternion } from "three";
import { compileMotion } from "../src/motion/engine";
import type { MotionProgram } from "../src/motion/types";

// Real public form, real remote language programs, one request at a time.
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/public-chinese-motion.spec.ts --workers=1
test.skip(process.env.AVATAR_LIVE_PUBLIC !== "1", "Opt in to real public Chinese motion inference.");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 960 }, video: "on", launchOptions: { args: [
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader",
] } });

type Evidence = { calls: unknown[]; samples: unknown[]; errors: string[] };
const evidence = new WeakMap<Page, Evidence>();
const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
const angle = (a: number[], b: number[]) => new Quaternion().fromArray(a).normalize().angleTo(new Quaternion().fromArray(b).normalize());

test.beforeEach(async ({ page }) => {
  test.setTimeout(600_000);
  const record: Evidence = { calls: [], samples: [], errors: [] };
  evidence.set(page, record);
  page.on("pageerror", error => record.errors.push(error.message));
});

test.afterEach(async ({ page }, testInfo) => {
  const record = evidence.get(page)!;
  await testInfo.attach("chinese-motion-inputs-and-poses", { body: JSON.stringify(record, null, 2), contentType: "application/json" });
  if (!page.isClosed()) {
    const path = testInfo.outputPath("chinese-motion-final.png");
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("chinese-motion-final", { path, contentType: "image/png" });
  }
  expect(record.errors).toEqual([]);
});

async function open(page: Page, path: "/avatar" | "/gangnam", reset = false) {
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  expect(url.origin).toBe("https://programasweights.com");
  url.pathname = path;
  url.search = "?dbg=1&quality=low";
  await page.goto(url.href);
  await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion, undefined, { timeout: 90_000 });
  const initial = await state(page);
  expect(initial.character).toBe(path === "/avatar" ? "jade" : "gangnam");
  expect(initial.program.dance?.style).toBe(path === "/gangnam" ? "gangnam" : undefined);
  if (reset) await page.getByRole("button", { name: "Start over", exact: true }).click();
  const current = await state(page);
  // Start over commits the scene before the stage consumes its new timeline.
  // Wait for that handoff before measuring the neutral reference pose.
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline), { timeout: 30_000 }).toEqual(compileMotion(current.program));
  return current;
}

async function requestDirection(page: Page, instruction: string) {
  const before = await state(page);
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const responsePromise = page.waitForResponse(response => {
    const request = response.request(), url = new URL(response.url());
    return request.method() === "POST" && url.origin === "https://programasweights.com"
      && url.pathname === "/api/v1/avatar/direct" && request.postDataJSON().instruction === instruction;
  }, { timeout: 180_000 });
  const started = Date.now();
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const response = await responsePromise, result = await response.json();
  evidence.get(page)!.calls.push({ instruction, status: response.status(), result, elapsedMs: Date.now() - started });
  expect(response.status()).toBe(200);
  expect(result).toMatchObject({ output: expect.any(String), trace: expect.any(Object) });
  await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled({ timeout: 180_000 });
  expect(evidence.get(page)!.errors).toEqual([]);
  return { before, result };
}

async function assertApplied(page: Page, before: Awaited<ReturnType<typeof state>>) {
  await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await state(page);
  expect(current.character).toBe(before.character);
  expect(current.focus).toBe("body");
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline), { timeout: 30_000 }).toEqual(compileMotion(current.program));
  return current;
}

async function direct(page: Page, instruction: string, expected: string) {
  const { before, result } = await requestDirection(page, instruction);
  expect(result.output).toBe(expected);
  return assertApplied(page, before);
}

async function samples(page: Page, fractions = [.2, .5, .8]) {
  const values = await page.evaluate(fractions => {
    const studio = (window as any).__motionStudio, motion = (window as any).__motion;
    return fractions.map(fraction => {
      const time = motion.timeline.duration * fraction;
      studio.seek(time); motion.seek(time);
      return { time, pose: motion.snapshot() };
    });
  }, fractions);
  evidence.get(page)!.samples.push(...values);
  return values.map(value => value.pose);
}

async function assertSupport(page: Page, side: "left" | "right") {
  const free = side === "left" ? "right" : "left";
  for (const pose of await samples(page))
    expect(pose[`${free}_ankle`].position[1] - pose[`${side}_ankle`].position[1], "The named raised foot is the free foot, never the support.").toBeGreaterThan(.2);
}

async function assertRightPunch(page: Page) {
  const [guard, strike, finish] = await samples(page, [0, .43, 1]);
  expect(strike.right_wrist.position[2] - guard.right_wrist.position[2]).toBeGreaterThan(.25);
  for (const joint of ["left_shoulder", "left_elbow", "left_wrist", "left_ankle", "right_ankle"])
    expect(distance(strike[joint].position, guard[joint].position)).toBeLessThan(.002);
  expect(distance(finish.right_wrist.position, guard.right_wrist.position)).toBeLessThan(1e-7);
}

function assertUpperBodyPreserved(before: MotionProgram, after: MotionProgram) {
  const withoutWrapper = <T extends { ancestors: string[] }>(track: T) => ({
    ...track, ancestors: track.ancestors.filter(id => id !== "motion_with_support"),
  });
  const upper = (program: MotionProgram) => compileMotion(program).tracks.filter(track =>
    !/^(root|hips|(?:left|right)_(?:hip|knee|ankle|toes|foot_ik|knee_pole|foot_ik_enabled))$/.test(track.target),
  ).map(withoutWrapper);
  expect(upper(after)).toEqual(upper(before));
  expect(compileMotion(after).contacts?.map(withoutWrapper)).toEqual(compileMotion(before).contacts?.map(withoutWrapper));
  expect(after.props).toEqual(before.props);
  expect(compileMotion(after).duration).toBe(compileMotion(before).duration);
}

test("Chinese foot lifts and English follow-ups work on the ordinary avatar hand showcase", async ({ page }) => {
  const original = await open(page, "/avatar");
  const leftUp = await direct(page, "抬左脚", "support right");
  expect(leftUp.program.dance).toBeUndefined();
  assertUpperBodyPreserved(original.program, leftUp.program);
  await assertSupport(page, "right");
  const switched = await direct(page, "Switch to the opposite foot.", "support other");
  assertUpperBodyPreserved(original.program, switched.program);
  await assertSupport(page, "left");
  const restored = await direct(page, "Both feet again.", "support both");
  expect(restored.program).toEqual(original.program);
});

test("Chinese left and right foot lifts preserve the current Gangnam dance", async ({ page }) => {
  const original = await open(page, "/gangnam");
  for (const [instruction, side] of [["抬左脚", "right"], ["抬右脚", "left"]] as const) {
    const current = await direct(page, instruction, `support ${side}`);
    expect(current.program.dance).toEqual({ style: "gangnam", support: side });
    assertUpperBodyPreserved(original.program, current.program);
    await assertSupport(page, side);
  }
});

test("raising a Chinese hand request selects its arm and keeps ordinary raises below overhead", async ({ page }) => {
  await open(page, "/avatar", true);
  const [rest] = await samples(page, [.5]);
  for (const [instruction, side] of [["抬左手", "left"], ["举左手", "left"], ["抬右手", "right"], ["举右手", "right"]] as const) {
    const current = await direct(page, instruction, `joint ${side}_shoulder z ${side === "left" ? 45 : -45}`);
    expect(current.program.dance).toBeUndefined();
    expect(current.selectedTargets).toContain(`${side}_shoulder`);
    const [pose] = await samples(page, [.5]);
    expect(angle(pose[`${side}_shoulder`].quaternion, rest[`${side}_shoulder`].quaternion)).toBeCloseTo(Math.PI / 4, 5);
    expect(pose[`${side}_wrist`].position[1] - rest[`${side}_wrist`].position[1]).toBeGreaterThan(.1);
    expect(pose[`${side}_wrist`].position[1]).toBeLessThan(pose.head.position[1]);
  }
});

test("Chinese and English hand waves leave Gangnam footwork running", async ({ page }) => {
  const original = await open(page, "/gangnam");
  const fractions = [.1, .25, .4, .55, .7, .85], baseline = await samples(page, fractions);
  for (const [instruction, side] of [["摆左手", "left"], ["Wave hello with your right hand", "right"]] as const) {
    const current = await direct(page, instruction, `wave ${side}`);
    expect(current.program.dance).toEqual(original.program.dance);
    const poses = await samples(page, fractions);
    for (const [index, pose] of poses.entries())
      for (const target of ["hips", "left_ankle", "right_ankle"])
        expect(distance(pose[target].position, baseline[index][target].position), `${target} keeps the same dance phase.`).toBeLessThan(1e-6);
    expect(Math.max(...poses.map(pose => angle(pose[`${side}_wrist`].quaternion, poses[0][`${side}_wrist`].quaternion)))).toBeGreaterThan(.2);
  }
});

test("Chinese bounce, counted jump and bow requests produce the corresponding body motion", async ({ page }) => {
  await open(page, "/avatar", true);
  for (const [instruction, count] of [["蹦", 1], ["跳", 1], ["跳两次", 2]] as const) {
    const current = await direct(page, instruction, `action jump ${count}`);
    expect(current.loop).toBe(false);
    const poses = await samples(page, Array.from({ length: count * 60 + 1 }, (_, index) => index / (count * 60)));
    let airborne = false, takeoffs = 0;
    for (const pose of poses) {
      const height = Math.min(...["left", "right"].map(side => pose[`${side}_ankle`].position[1] - poses[0][`${side}_ankle`].position[1]));
      if (height > .08 && !airborne) { takeoffs++; airborne = true; }
      if (height < .02) airborne = false;
    }
    expect(takeoffs).toBe(count);
  }
  await direct(page, "鞠躬", "action bow 1");
  const [upright, bowed] = await samples(page, [0, .5]);
  expect(bowed.head.position[2] - upright.head.position[2]).toBeGreaterThan(.3);
  expect(upright.head.position[1] - bowed.head.position[1]).toBeGreaterThan(.2);
});

test("Chinese and English swaying transfer weight in both directions with planted feet on both characters", async ({ page }) => {
  for (const [path, instruction] of [["/avatar", "左右摆动"], ["/gangnam", "Rock your body from side to side."]] as const) {
    await open(page, path);
    const current = await direct(page, instruction, "action sway 1");
    expect(current.program.dance).toBeUndefined();
    const [center, left, right, finish] = await samples(page, [0, .25, .75, 1]);
    expect(left.hips.position[0] - center.hips.position[0]).toBeGreaterThan(.08);
    expect(right.hips.position[0] - center.hips.position[0]).toBeLessThan(-.08);
    expect(left.head.position[0] - center.head.position[0]).toBeGreaterThan(.13);
    expect(right.head.position[0] - center.head.position[0]).toBeLessThan(-.13);
    for (const pose of [left, right, finish])
      for (const side of ["left", "right"])
        expect(distance(pose[`${side}_ankle`].position, center[`${side}_ankle`].position)).toBeLessThan(.002);
    expect(distance(finish.hips.position, center.hips.position)).toBeLessThan(1e-6);
  }
});

test("natural English and Chinese hand raises and foot lowering share the same avatar behavior", async ({ page }) => {
  await open(page, "/avatar", true);
  const [rest] = await samples(page, [.5]);
  for (const instruction of ["Raise your left hand.", "举左手"]) {
    const current = await direct(page, instruction, "joint left_shoulder z 45");
    expect(current.selectedTargets).toContain("left_shoulder");
    const [pose] = await samples(page, [.5]);
    expect(angle(pose.left_shoulder.quaternion, rest.left_shoulder.quaternion)).toBeCloseTo(Math.PI / 4, 5);
    expect(pose.left_wrist.position[1] - rest.left_wrist.position[1]).toBeGreaterThan(.1);
  }
  for (const [raise, lower] of [["Lift a foot.", "Put your foot down."], ["抬脚", "脚放下"]]) {
    const original = await state(page);
    const lifted = await direct(page, raise, "support left");
    assertUpperBodyPreserved(original.program, lifted.program);
    await assertSupport(page, "left");
    const restored = await direct(page, lower, "support both");
    expect(restored.program).toEqual(original.program);
    for (const pose of await samples(page))
      expect(Math.abs(pose.left_ankle.position[1] - pose.right_ankle.position[1])).toBeLessThan(.002);
  }
});

test("paired clap and applause requests produce palm contact", async ({ page }) => {
  await open(page, "/avatar", true);
  for (const instruction of ["拍手", "Clap your hands.", "鼓掌", "Applaud."]) {
    const current = await direct(page, instruction, "action clap 1");
    expect(current.program.dance).toBeUndefined();
    const [openPose, contact, finish] = await samples(page, [0, .47, 1]);
    expect(distance(openPose.left_wrist.position, openPose.right_wrist.position)).toBeGreaterThan(.3);
    expect(distance(contact.left_wrist.position, contact.right_wrist.position)).toBeLessThan(.04);
    for (const side of ["left", "right"])
      for (const pose of [contact, finish])
        expect(distance(pose[`${side}_ankle`].position, openPose[`${side}_ankle`].position)).toBeLessThan(.002);
    for (const side of ["left", "right"])
      expect(distance(finish[`${side}_wrist`].position, openPose[`${side}_wrist`].position)).toBeLessThan(1e-7);
  }
});

test("proper Chinese and English punch requests produce fist extension", async ({ page }) => {
  await open(page, "/avatar", true);
  for (const instruction of ["出拳", "Throw a punch."]) {
    await direct(page, instruction, "action punch_right 1");
    await assertRightPunch(page);
  }
});

test("known coverage gap: the visitor punch typo still requires a punch", async ({ page }, testInfo) => {
  await open(page, "/avatar", true);
  const { before, result } = await requestDirection(page, "打挙");
  if (result.output === "unsupported" && result.trace.motion_translation === "Do a backflip.") {
    testInfo.annotations.push({ type: "known-coverage-gap", description: "recent_punch_zh: 打挙 is mistranslated as a backflip; the required output remains action punch_right 1." });
    test.fail(true, "Known exact translation failure for 打挙; the benchmark's punch expectation is unchanged.");
  }
  expect(result.output).toBe("action punch_right 1");
  await assertApplied(page, before);
  await assertRightPunch(page);
});
