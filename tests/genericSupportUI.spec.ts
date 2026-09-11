import { expect, test, type Page } from "@playwright/test";
import { compileMotion, findNode } from "../src/motion/engine";
import type { MotionProgram } from "../src/motion/types";

// Controlled remote responses exercise the actual editor and jade rig. The
// opt-in public-generic-support suite checks these phrases with real inference.
test.use({ viewport: { width: 1280, height: 960 }, launchOptions: { args: [
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader",
] } });

const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
const outputs: Record<string, string> = {
  "Lift left leg": "support right",
  "抬左腿": "support right",
  "Balance on your left foot.": "support left",
  "Switch to the opposite foot.": "support other",
  "Both feet again.": "support both",
  "Dance salsa": "dance salsa",
  "Wiggle only the left index finger 65 degrees": "wiggle left_index_1 z 65",
};

async function ready(page: Page) {
  await page.route("**/api/direct", route => {
    const instruction = route.request().postDataJSON().instruction;
    expect(Object.hasOwn(outputs, instruction), `Unexpected request: ${instruction}`).toBe(true);
    return route.fulfill({ json: { output: outputs[instruction], trace: { mocked: true } } });
  });
  await page.goto("/avatar?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion);
  expect((await state(page)).character).toBe("jade");
  expect((await state(page)).program.dance).toBeUndefined();
}

async function direct(page: Page, instruction: string, focus = "body") {
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const response = page.waitForResponse(r => r.url().endsWith("/api/direct")
    && r.request().postDataJSON().instruction === instruction);
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await state(page);
  expect(current.character).toBe("jade");
  expect(current.program.dance?.style).not.toBe("gangnam");
  expect(current.focus).toBe(focus);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline)).toEqual(compileMotion(current.program));
  return current;
}

async function assertSupport(page: Page, side: "left" | "right") {
  const samples = await page.evaluate(() => {
    const motion = (window as any).__motion, studio = (window as any).__motionStudio;
    return [.2, .5, .8].map(fraction => {
      const time = motion.timeline.duration * fraction;
      studio.seek(time); motion.seek(time);
      return motion.snapshot();
    });
  });
  const free = side === "left" ? "right" : "left";
  for (const pose of samples) {
    expect(pose[`${side}_ankle`].position[1], "The supporting foot stays at floor height.").toBeLessThan(.15);
    expect(pose[`${free}_ankle`].position[1] - pose[`${side}_ankle`].position[1], "The requested leg is visibly raised.").toBeGreaterThan(.2);
  }
}

function assertUpperBodyPreserved(before: MotionProgram, after: MotionProgram) {
  // A sequence needs a parallel parent for the stance overlay. That one new
  // ancestor changes tree navigation, not any authored track or contact.
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

test("the default avatar hand sequence can lift either leg and restore its original footwork without Gangnam", async ({ page }) => {
  await ready(page);
  const original = await state(page);
  expect(original.program.props).toHaveLength(1);
  const raised = await direct(page, "Lift left leg");
  assertUpperBodyPreserved(original.program, raised.program);
  await assertSupport(page, "right");
  const switched = await direct(page, "Switch to the opposite foot.");
  assertUpperBodyPreserved(original.program, switched.program);
  await assertSupport(page, "left");
  const restored = await direct(page, "Both feet again.");
  expect(restored.program).toEqual(original.program);
});

test("a new jade episode supports Chinese leg directions and retains individual finger edits", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  const original = await state(page);
  const raised = await direct(page, "抬左腿");
  assertUpperBodyPreserved(original.program, raised.program);
  await assertSupport(page, "right");
  const finger = await direct(page, "Wiggle only the left index finger 65 degrees", "left_hand");
  expect(finger.selectedTargets).toContain("left_index_1");
  expect(compileMotion(finger.program).tracks.some(track => track.target === "left_index_1" && track.curve.kind === "sine")).toBe(true);
  await assertSupport(page, "right");
  const switched = await direct(page, "Switch to the opposite foot.");
  expect(findNode(switched.program.root, "details")).toEqual(findNode(finger.program.root, "details"));
  await assertSupport(page, "left");
});

test("salsa support edits preserve the actual arms and return to the original salsa steps", async ({ page }) => {
  await ready(page);
  const salsa = await direct(page, "Dance salsa");
  const balanced = await direct(page, "Balance on your left foot.");
  assertUpperBodyPreserved(salsa.program, balanced.program);
  await assertSupport(page, "left");
  const restored = await direct(page, "Both feet again.");
  expect(restored.program).toEqual(salsa.program);
});
