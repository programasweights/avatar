import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Quaternion } from "three";
import { findNode } from "../src/motion/engine";

test.use({
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] },
});

async function studio(page: Page) {
  const outputs: Record<string, string> = {
    "Pause head.": "freeze head",
    "Pause both shoulders.": "freeze both_shoulder",
    "Pause left shoulder.": "freeze left_shoulder",
    "Pause right shoulder.": "freeze right_shoulder",
    "Make the arms robotic.": "arms robot",
    "Wave with the left hand.": "wave left",
    "Keep the arms still.": "arms still",
    "Lower the left arm.": "arm left still",
    "Switch to the right foot.": "support right",
  };
  await page.route("**/api/direct", (route) => {
    const { instruction } = route.request().postDataJSON();
    expect(Object.hasOwn(outputs, instruction)).toBe(true);
    return route.fulfill({ json: { output: outputs[instruction], trace: { mocked: true } } });
  });
  await page.goto("/gangnam?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  await expect(page.getByText("Loading the character…")).toBeHidden();
  return async (instruction: string) => {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/direct"));
    await page.getByRole("button", { name: "Apply direction", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.locator(".motion-caption p")).toHaveText(instruction);
    await expect(page.getByRole("alert")).toHaveCount(0);
    return page.evaluate(() => (window as any).__motionStudio.snapshot());
  };
}

async function sampleLocalArms(page: Page, fractions = [0, 0.25]) {
  return page.evaluate((fractions) => {
    const motion = (window as any).__motion;
    return fractions.map((fraction) => {
      const time = motion.timeline.duration * fraction;
      motion.seek(time);
      return Object.fromEntries(["head", "left_shoulder", "right_shoulder", "left_wrist", "right_wrist"].map((joint) => [
        joint, motion.rig.joints.get(joint).bone.quaternion.toArray(),
      ]));
    });
  }, fractions);
}
const rotationChange = (samples: Record<string, number[]>[], joint: string) =>
  new Quaternion().fromArray(samples[0][joint]).angleTo(new Quaternion().fromArray(samples[1][joint]));
const frozenTargets = (state: any): string[] => state.frozen.flatMap((token: any) => token.targets).sort();

test("new arm and one-sided wave commands release matching pauses and preserve other pauses, support and phase", async ({ page }) => {
  const direct = await studio(page);
  await direct("Pause head.");
  await direct("Pause both shoulders.");
  await page.evaluate(() => (window as any).__motion.seek(1.5));
  const robot = await direct("Make the arms robotic.");
  expect(frozenTargets(robot)).toEqual(["head"]);
  expect(robot.time).toBeGreaterThanOrEqual(1.5);
  expect(robot.playing).toBe(true);
  expect(robot.program.dance).toEqual({ style: "gangnam", support: "both" });
  const robotPoses = await sampleLocalArms(page);
  expect(rotationChange(robotPoses, "left_shoulder")).toBeGreaterThan(0.8);
  expect(rotationChange(robotPoses, "right_shoulder")).toBeGreaterThan(0.8);
  expect(rotationChange(robotPoses, "head")).toBeLessThan(1e-6);
  const supported = await direct("Switch to the right foot.");
  expect(supported.program.dance?.support).toBe("right");
  expect(findNode(supported.program.root, "arms")).toEqual(findNode(robot.program.root, "arms"));
  expect(frozenTargets(supported)).toEqual(["head"]);
  await direct("Pause left shoulder.");
  await direct("Pause right shoulder.");
  const waving = await direct("Wave with the left hand.");
  expect(frozenTargets(waving)).toEqual(["head", "right_shoulder"]);
  const wavePoses = await sampleLocalArms(page, [1 / 24, 1 / 8]);
  expect(rotationChange(wavePoses, "left_wrist")).toBeGreaterThan(0.4);
  expect(rotationChange(wavePoses, "right_shoulder")).toBeLessThan(1e-6);
  expect(rotationChange(wavePoses, "head")).toBeLessThan(1e-6);
  await direct("Pause left shoulder.");
  const lowered = await direct("Lower the left arm.");
  expect(frozenTargets(lowered)).toEqual(["head", "right_shoulder"]);
  expect(lowered.program.dance?.support).toBe("right");
  const loweredPoses = await sampleLocalArms(page);
  expect(rotationChange(loweredPoses, "left_shoulder")).toBeLessThan(1e-6);
  await direct("Pause left shoulder.");
  const still = await direct("Keep the arms still.");
  expect(frozenTargets(still)).toEqual(["head"]);
  expect(still.program.dance?.support).toBe("right");
  const stillPoses = await sampleLocalArms(page);
  for (const joint of ["left_shoulder", "right_shoulder", "left_wrist", "right_wrist"])
    expect(rotationChange(stillPoses, joint)).toBeLessThan(1e-6);
});

test("arm dropdown and joint-angle controls release only their targeted pauses", async ({ page }) => {
  const direct = await studio(page);
  await direct("Pause head.");
  await direct("Pause both shoulders.");
  await page.getByText("Edit motion", { exact: true }).click();
  await page.getByLabel("Arm choreography", { exact: true }).selectOption("robot");
  await expect.poll(async () => frozenTargets(await page.evaluate(() => (window as any).__motionStudio.snapshot()))).toEqual(["head"]);
  const samples = await sampleLocalArms(page);
  expect(rotationChange(samples, "left_shoulder")).toBeGreaterThan(0.8);
  await direct("Pause left shoulder.");
  await direct("Pause right shoulder.");
  await page.getByLabel("Joint", { exact: true }).selectOption("left_shoulder");
  await page.getByLabel("Joint axis", { exact: true }).selectOption("z");
  await page.getByLabel("Joint angle", { exact: true }).focus();
  await page.getByLabel("Joint angle", { exact: true }).press("ArrowRight");
  const edited = await page.evaluate(() => (window as any).__motionStudio.snapshot());
  expect(frozenTargets(edited)).toEqual(["head", "right_shoulder"]);
  expect(findNode(edited.program.root, "detail.left_shoulder.z")).toMatchObject({ curve: { kind: "constant", value: 1 } });
  expect(edited.program.dance).toEqual({ style: "gangnam", support: "both" });
});
