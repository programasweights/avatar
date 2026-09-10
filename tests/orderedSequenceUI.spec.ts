import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { compileMotion } from "../src/motion/engine";
import { createBodyAction } from "../src/motion/bodyActions";
import { GANGNAM_BPM } from "../src/motion/gangnam";

test.use({ launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] } });
const instruction = "Dance Gangnam, lower the left arm, then bow.";
const plan = {
  kind: "sequence",
  steps: [
    { instruction: "Dance Gangnam Style.", commands: "dance gangnam", mode: "perform", seconds: 2 },
    { instruction: "Now lower your left arm.", commands: "arm left still", mode: "continue", seconds: 2 },
    { instruction: "Bow.", commands: "action bow 1", mode: "perform" },
  ],
};
const handInstruction = "Ripple the left fingers, then touch each fingertip.";
const handPlan = { kind: "sequence", steps: [
  { instruction: "Ripple the left fingers.", commands: "skill finger_ripple left forward", mode: "perform", seconds: 2 },
  { instruction: "Touch each left fingertip.", commands: "skill finger_touches left forward", mode: "perform", seconds: 2 },
] };
const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
async function seek(page: Page, time: number) {
  await page.evaluate((time) => {
    (window as any).__motionStudio.seek(time);
    (window as any).__motion.seek(time);
  }, time);
}
async function setup(page: Page) {
  const outputs: Record<string, string> = {
    [instruction]: JSON.stringify(plan),
    [handInstruction]: JSON.stringify(handPlan),
    "Pause head.": "freeze head",
    "Half speed.": "tempo_scale 0.5",
    "Make the right arm robotic.": "arm right robot",
    "Invalid middle step.": JSON.stringify({ ...plan, steps: plan.steps.map((step, i) => i === 1 ? { ...step, commands: "skill teleport left forward" } : step) }),
  };
  await page.route("**/api/direct", (route) => {
    const text = route.request().postDataJSON().instruction;
    expect(Object.hasOwn(outputs, text)).toBe(true);
    return route.fulfill({ json: { output: outputs[text], trace: { mocked: true } } });
  });
  await page.goto("/avatar?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  return async (text: string, fail = false) => {
    await page.getByLabel("Direction", { exact: true }).fill(text);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/direct"));
    await page.getByRole("button", { name: "Apply direction", exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled();
    if (fail) await expect(page.getByRole("alert")).toContainText("invalid command");
    else expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    return state(page);
  };
}

test("an ordered direction creates a finite episode with phase captions and updates cue timing after edits", async ({ page }) => {
  const direct = await setup(page);
  await direct("Pause head.");
  await seek(page, 4);
  const sequence = await direct(instruction);
  await expect(page.getByText("Loading the character…")).toBeHidden();
  expect(sequence.program.root.id).toBe("ordered_sequence");
  expect(compileMotion(sequence.program).duration).toBeCloseTo(4 + compileMotion(createBodyAction("bow", 1, GANGNAM_BPM)).duration, 8);
  expect(sequence.time).toBeLessThan(1);
  expect(sequence.playing).toBe(true);
  expect(sequence.loop).toBe(false);
  expect(sequence.frozen).toEqual([]);
  expect(sequence.character).toBe("gangnam");
  expect(sequence.focus).toBe("body");
  expect(sequence.cues.map((cue: any) => cue.instruction)).toEqual(plan.steps.map((step) => step.instruction));
  for (const [index, cue] of sequence.cues.entries()) {
    await seek(page, cue.start + cue.duration * 0.7);
    await expect(page.locator(".motion-caption p")).toHaveText(cue.instruction);
    await expect(page.locator(".motion-caption > span")).toHaveText(`STEP ${index + 1} OF 3`);
  }
  const slower = await direct("Half speed.");
  expect(slower.loop).toBe(false);
  expect(slower.cues.map((cue: any) => cue.start)).toEqual(sequence.cues.map((cue: any) => cue.start * 2));
  expect(slower.cues.map((cue: any) => cue.duration)).toEqual(sequence.cues.map((cue: any) => cue.duration * 2));
  const arms = await direct("Make the right arm robotic.");
  expect(arms.cues).toEqual(slower.cues);
  expect(arms.loop).toBe(false);
  const paused = await direct("Pause head.");
  expect(paused.cues).toEqual(slower.cues);
  const duration = compileMotion(paused.program).duration;
  await seek(page, duration - 0.03);
  await page.getByRole("button", { name: "Play current motion", exact: true }).click();
  await expect.poll(async () => (await state(page)).playing).toBe(false);
  expect((await state(page)).time).toBeCloseTo(duration, 8);
  await expect(page.locator(".motion-caption p")).toHaveText("Bow.");
});

test("an invalid middle phase leaves the complete existing sequence, pauses, and transport unchanged", async ({ page }) => {
  const direct = await setup(page);
  await direct(instruction);
  await expect(page.getByText("Loading the character…")).toBeHidden();
  await direct("Pause head.");
  await seek(page, 2.5);
  await expect(page.locator(".motion-caption p")).toHaveText("Now lower your left arm.");
  const before = await state(page);
  const after = await direct("Invalid middle step.", true);
  for (const field of ["program", "frozen", "cues", "time", "playing", "loop", "caption", "character", "focus"])
    expect(after[field], field).toEqual(before[field]);
});

test("an ordered hand-only direction keeps a useful close-up and remains finite", async ({ page }) => {
  const direct = await setup(page);
  const sequence = await direct(handInstruction);
  expect(sequence.focus).toBe("left_hand");
  expect(sequence.loop).toBe(false);
  expect(sequence.playing).toBe(true);
  expect(sequence.cues).toHaveLength(2);
  for (const cue of sequence.cues) {
    await seek(page, cue.start + cue.duration * 0.6);
    await expect(page.locator(".motion-caption p")).toHaveText(cue.instruction);
  }
});
