import { expect, test, type Page } from "@playwright/test";
import { compileMotion, findNode } from "../src/motion/engine";

// Opt in only after the remote endpoint is ready. No routes or model outputs are mocked.
test.skip(process.env.AVATAR_LIVE_PUBLIC !== "1", "Opt in to real public arm and ordered-motion inference.");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 960 }, launchOptions: {
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"],
} });

const evidence = new WeakMap<Page, { calls: any[]; samples: any[]; errors: string[] }>();
const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]));
const angle = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0))));

test.beforeEach(async ({ page }) => {
  test.setTimeout(600_000);
  const record: { calls: any[]; samples: any[]; errors: string[] } = { calls: [], samples: [], errors: [] };
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
  await testInfo.attach("remote-commands-and-rendered-poses", { body: JSON.stringify(record, null, 2), contentType: "application/json" });
  if (testInfo.status === "passed") {
    const path = testInfo.outputPath("result.png");
    await page.locator(".motion-stage").screenshot({ path });
    await testInfo.attach("result", { path, contentType: "image/png" });
  }
  expect(record.errors).toEqual([]);
});

async function direct(page: Page, instruction: string, expected?: string) {
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const responsePromise = page.waitForResponse(response => {
    const request = response.request();
    return request.method() === "POST" && ["/api/v1/avatar/direct", "/api/direct"].includes(new URL(response.url()).pathname)
      && request.postDataJSON().instruction === instruction;
  }, { timeout: 180_000 });
  const started = Date.now();
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const response = await responsePromise;
  const result = await response.json();
  evidence.get(page)!.calls.push({ instruction, status: response.status(), result, elapsedMs: Date.now() - started });
  expect(response.status()).toBe(200);
  if (expected !== undefined) expect(result.output).toBe(expected);
  await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled({ timeout: 180_000 });
  if (expected === "unsupported") await expect(page.getByRole("alert")).toBeVisible();
  else await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await state(page);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline), { timeout: 30_000 }).toEqual(compileMotion(current.program));
  return { ...current, output: result.output };
}

async function sample(page: Page, time: number) {
  const sample = await page.evaluate(time => {
    const studio = (window as any).__motionStudio, motion = (window as any).__motion;
    studio.seek(time);
    motion.seek(time);
    return { time, pose: motion.snapshot(), neutral: Object.fromEntries([...motion.rig.joints].map(([id, ref]: any) => [id, ref.rotation.toArray()])) };
  }, time);
  evidence.get(page)!.samples.push(sample);
  for (const joint of Object.values(sample.pose) as any[]) expect([...joint.position, ...joint.quaternion].every(Number.isFinite)).toBe(true);
  return sample;
}

async function play(page: Page) {
  if (!(await state(page)).playing) await page.getByRole("button", { name: "Play current motion", exact: true }).click();
}

test("lowering an arm clears its raised pose and a new arm style releases only its affected freeze", async ({ page }) => {
  const initial = await state(page);
  const raised = await direct(page, "Raise your left arm 90 degrees.", "joint left_shoulder z 90");
  const raisedPose = await sample(page, 1.4);
  await play(page);
  await page.evaluate(() => {
    const watch = { previous: null as any, transition: null as any, active: true };
    (window as any).__armPhaseWatch = watch;
    const tick = () => {
      const value = (window as any).__motionStudio.snapshot();
      const current = { program: value.program, time: value.time, at: performance.now() };
      if (watch.previous && current.program !== watch.previous.program && !watch.transition)
        watch.transition = { before: { time: watch.previous.time, at: watch.previous.at }, after: { time: current.time, at: current.at } };
      watch.previous = current;
      if (watch.active) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const lowered = await direct(page, "Lower your left arm.", "arm left still");
  await page.waitForFunction(() => (window as any).__armPhaseWatch.transition !== null);
  const transition = await page.evaluate(() => { (window as any).__armPhaseWatch.active = false; return (window as any).__armPhaseWatch.transition; });
  const duration = compileMotion(initial.program).duration;
  const advance = (transition.after.time - transition.before.time + duration) % duration;
  expect(Math.abs(advance - (transition.after.at - transition.before.at) / 1000)).toBeLessThan(0.25);
  expect(findNode(lowered.program.root, "feet")).toEqual(findNode(raised.program.root, "feet"));
  const loweredPose = await sample(page, 1.4);
  expect(distance(raisedPose.pose.left_wrist.position, loweredPose.pose.left_wrist.position)).toBeGreaterThan(0.2);
  for (const joint of ["left_clavicle", "left_shoulder", "left_elbow", "left_wrist"])
    expect(angle(loweredPose.pose[joint].quaternion, loweredPose.neutral[joint]), `${joint} returns to neutral`).toBeLessThan(1e-5);
  for (const joint of ["right_shoulder", "right_elbow", "right_wrist", "left_ankle", "right_ankle"])
    expect(loweredPose.pose[joint], `${joint} is preserved`).toEqual(raisedPose.pose[joint]);
  // A shoulder freeze exercises the existing supported joint target; the head
  // freeze proves that replacing an arm does not clear unrelated frozen parts.
  const frozenArm = await direct(page, "Freeze your left shoulder.", "freeze left_shoulder");
  const frozenHead = await direct(page, "Freeze your head.", "freeze head");
  expect(frozenArm.frozen.some((token: any) => token.targets.includes("left_shoulder"))).toBe(true);
  const unrelated = frozenHead.frozen.filter((token: any) => token.targets.includes("head"));
  expect(unrelated).toHaveLength(1);
  const robotic = await direct(page, "Make only your left arm robotic.", "arm left robot");
  expect(robotic.frozen).toEqual(unrelated);
  const first = await sample(page, 0.8), second = await sample(page, 2.3);
  expect(first.pose.head.quaternion).toEqual(second.pose.head.quaternion);
  expect(angle(first.pose.left_shoulder.quaternion, first.neutral.left_shoulder)).toBeGreaterThan(0.2);
});

test("a right-hand wave then bow plays distinct finite phases with matching instructions", async ({ page }) => {
  const current = await direct(page, "Wave your right hand, then bow.");
  const plan = JSON.parse(current.output);
  expect(plan.kind).toBe("sequence");
  expect(plan.steps).toHaveLength(2);
  expect(["wave right", "arm right wave"]).toContain(plan.steps[0].commands);
  expect(plan.steps[1].commands).toBe("action bow 1");
  expect(plan.steps.every((step: any) => step.mode === "perform")).toBe(true);
  expect(current.loop).toBe(false);
  expect(current.cues.map((cue: any) => cue.instruction)).toEqual(plan.steps.map((step: any) => step.instruction));
  const [wave, bow] = current.cues;
  const a = await sample(page, wave.start + wave.duration * .35);
  const b = await sample(page, wave.start + wave.duration * .65);
  expect(angle(a.pose.right_wrist.quaternion, b.pose.right_wrist.quaternion)).toBeGreaterThan(.1);
  await expect(page.locator(".motion-caption p")).toHaveText(wave.instruction);
  const bowed = await sample(page, bow.start + bow.duration * .55);
  await expect(page.locator(".motion-caption p")).toHaveText(bow.instruction);
  expect(angle(bowed.pose.spine.quaternion, bowed.neutral.spine) + angle(bowed.pose.chest.quaternion, bowed.neutral.chest)).toBeGreaterThan(.2);
  expect(JSON.stringify(plan.steps)).not.toMatch(/action (jump|run|walk)/);
  await sample(page, 0);
  await play(page);
  await expect(page.locator(".motion-caption p")).toHaveText(wave.instruction);
  await expect(page.locator(".motion-caption p")).toHaveText(bow.instruction, { timeout: 15_000 });
  await expect.poll(async () => (await state(page)).playing, { timeout: 15_000 }).toBe(false);
  expect((await state(page)).time).toBeCloseTo(compileMotion(current.program).duration, 6);
});

test("timed Gangnam keeps its footwork continuous while robotic arms begin in the second phase", async ({ page }) => {
  const times = [1.2, 2.7, 4.3];
  const original = [];
  for (const time of times) original.push(await sample(page, time));
  const current = await direct(page, "Dance Gangnam for 2 seconds, then keep dancing with robotic arms for 3 seconds.");
  const plan = JSON.parse(current.output);
  expect(plan.steps.map((step: any) => [step.commands, step.mode, step.seconds])).toEqual([
    ["dance gangnam", "perform", 2], ["arms robot", "continue", 3],
  ]);
  expect(compileMotion(current.program).duration).toBeCloseTo(5, 8);
  expect(current.cues.map((cue: any) => cue.start)).toEqual([0, 2]);
  expect(current.loop).toBe(false);
  for (const [index, time] of times.entries()) {
    const rendered = await sample(page, time);
    for (const foot of ["left_ankle", "right_ankle"])
      expect(distance(rendered.pose[foot].position, original[index].pose[foot].position)).toBeLessThan(.003);
    if (time < 2) expect(distance(rendered.pose.right_wrist.position, original[index].pose.right_wrist.position)).toBeLessThan(.003);
    else expect(distance(rendered.pose.right_wrist.position, original[index].pose.right_wrist.position)).toBeGreaterThan(.1);
    await expect(page.locator(".motion-caption p")).toHaveText(current.cues[time < 2 ? 0 : 1].instruction);
  }
  const before = await sample(page, 1.9999), after = await sample(page, 2.0001);
  for (const foot of ["left_ankle", "right_ankle"])
    expect(distance(before.pose[foot].position, after.pose[foot].position)).toBeLessThan(.003);
});

test("an unsupported middle step leaves the current program and paused pose intact", async ({ page }) => {
  const beforePose = await sample(page, 1.3);
  const before = await state(page);
  const after = await direct(page, "First bow, then juggle three balls, then sit.", "unsupported");
  for (const field of ["program", "frozen", "cues", "time", "playing", "loop", "caption", "character", "focus"])
    expect(after[field], `${field} survives a rejected plan`).toEqual(before[field]);
  expect(await page.evaluate(() => (window as any).__motion.snapshot())).toEqual(beforePose.pose);
});
