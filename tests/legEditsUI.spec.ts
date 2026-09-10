import { expect, test, type Page } from "@playwright/test";
import { Quaternion } from "three";
import { armTargets, legTargets } from "../src/motion/editing";
import { compileMotion } from "../src/motion/engine";

test.use({ launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] } });

const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
const targets = (value: any): string[] => value.frozen.flatMap((token: any) => token.targets).sort();
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, i) => value - b[i]));
const angle = (a: number[], b: number[]) => new Quaternion().fromArray(a).normalize()
  .angleTo(new Quaternion().fromArray(b).normalize());

async function studio(page: Page) {
  const outputs: Record<string, string> = {
    "Stop your left leg movements.": "freeze left_leg",
    "Stop leg movements.": "freeze both_legs",
    "Resume the left leg.": "restore left_leg",
    "Resume both legs.": "restore both_legs",
    "Make it faster.": "tempo_scale 1.25",
    "Freeze your head.": "freeze head",
    "Make your arms robotic.": "arms robot",
    "Switch to the right foot.": "support right",
  };
  await page.route("**/api/direct", route => {
    const { instruction } = route.request().postDataJSON();
    expect(Object.hasOwn(outputs, instruction)).toBe(true);
    return route.fulfill({ json: { output: outputs[instruction], trace: { mocked: true } } });
  });
  await page.goto("/gangnam?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion && !!(window as any).__motionStudio, undefined, { timeout: 60_000 });
  return async (instruction: string) => {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    const response = page.waitForResponse(r => r.url().endsWith("/api/direct"));
    await page.getByRole("button", { name: "Apply direction", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.locator(".motion-caption p")).toHaveText(instruction);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const next = await state(page);
    await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline)).toEqual(compileMotion(next.program));
    return next;
  };
}

async function sample(page: Page) {
  return page.evaluate(() => {
    const studio = (window as any).__motionStudio, motion = (window as any).__motion;
    return Array.from({ length: 13 }, (_, index) => {
      const time = motion.timeline.duration * index / 12;
      studio.seek(time);
      motion.seek(time);
      return motion.snapshot();
    });
  });
}

function assertStill(samples: any[], joints: string[]) {
  for (const sample of samples)
    for (const joint of joints) {
      expect(distance(sample[joint].position, samples[0][joint].position), joint).toBeLessThan(1e-6);
      expect(angle(sample[joint].quaternion, samples[0][joint].quaternion), joint).toBeLessThan(1e-6);
    }
}

test("directions stop whole legs visibly, preserve dance phase, and restore each side independently", async ({ page }) => {
  test.setTimeout(150_000);
  const direct = await studio(page);
  const original = await state(page);
  const baseline = await sample(page);
  await page.evaluate(() => { (window as any).__motionStudio.seek(1.35); (window as any).__motion.seek(1.35); });
  const left = await direct("Stop your left leg movements.");
  expect(left.playing).toBe(true);
  expect(left.time).toBeGreaterThanOrEqual(1.35);
  expect(left.time).toBeLessThan(compileMotion(left.program).duration);
  expect(targets(left)).toEqual(legTargets("left").sort());
  let samples = await sample(page);
  assertStill(samples, [...legTargets("left"), "hips"]);
  expect(Math.max(...samples.map(pose => distance(pose.right_ankle.position, samples[0].right_ankle.position)))).toBeGreaterThan(0.05);
  for (let frame = 0; frame < samples.length; frame++)
    for (const joint of armTargets())
      expect(angle(samples[frame][joint].quaternion, baseline[frame][joint].quaternion), `${joint} phase`).toBeLessThan(1e-6);

  const both = await direct("Stop leg movements.");
  expect(targets(both)).toEqual(legTargets().sort());
  expect(both.playing).toBe(true);
  samples = await sample(page);
  assertStill(samples, [...legTargets(), "hips"]);
  expect(Math.max(...samples.map(pose => angle(pose.left_elbow.quaternion, samples[0].left_elbow.quaternion)))).toBeGreaterThan(0.1);

  const leftRestored = await direct("Resume the left leg.");
  expect(targets(leftRestored)).toEqual(legTargets("right").sort());
  samples = await sample(page);
  assertStill(samples, [...legTargets("right"), "hips"]);
  expect(Math.max(...samples.map(pose => distance(pose.left_ankle.position, samples[0].left_ankle.position)))).toBeGreaterThan(0.05);
  const restored = await direct("Resume both legs.");
  expect(targets(restored)).toEqual([]);
  expect(restored.program).toEqual(original.program);
  expect(restored.playing).toBe(true);
});

test("tempo and arm edits preserve paused legs; a new support request releases them without clearing unrelated pauses", async ({ page }) => {
  test.setTimeout(120_000);
  const direct = await studio(page);
  await direct("Stop leg movements.");
  const faster = await direct("Make it faster.");
  expect(targets(faster)).toEqual(legTargets().sort());
  assertStill(await sample(page), [...legTargets(), "hips"]);
  await direct("Freeze your head.");
  const arms = await direct("Make your arms robotic.");
  expect(targets(arms)).toEqual([...legTargets(), "head"].sort());
  assertStill(await sample(page), [...legTargets(), "hips"]);
  const support = await direct("Switch to the right foot.");
  expect(targets(support)).toEqual(["head"]);
  expect(support.program.dance).toEqual({ style: "gangnam", support: "right" });
  const samples = await sample(page);
  expect(samples.every(pose => pose.left_ankle.position[1] - pose.right_ankle.position[1] > 0.3)).toBe(true);
  expect(Math.max(...samples.map(pose => distance(pose.right_ankle.position, samples[0].right_ankle.position)))).toBeGreaterThan(0.01);
});
