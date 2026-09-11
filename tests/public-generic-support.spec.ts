import { expect, test, type Page } from "@playwright/test";
import { compileMotion } from "../src/motion/engine";
import type { MotionProgram } from "../src/motion/types";

// These requests go through the public form and hosted PAW director, in order.
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/public-generic-support.spec.ts --workers=1
test.skip(process.env.AVATAR_LIVE_PUBLIC !== "1", "Opt in to real public avatar support inference.");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 960 }, video: "on", launchOptions: { args: [
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader",
] } });

type Evidence = { calls: unknown[]; samples: unknown[]; errors: string[] };
const evidence = new WeakMap<Page, Evidence>();
const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());

test.beforeEach(async ({ page }) => {
  test.setTimeout(600_000);
  const record: Evidence = { calls: [], samples: [], errors: [] };
  evidence.set(page, record);
  page.on("pageerror", error => record.errors.push(error.message));
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  expect(url.origin, "Real public inference must use the deployed service.").toBe("https://programasweights.com");
  url.pathname = "/avatar";
  url.search = "?dbg=1&quality=low";
  await page.goto(url.href);
  await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion, undefined, { timeout: 90_000 });
  const current = await state(page);
  expect(current.character).toBe("jade");
  expect(current.program.dance).toBeUndefined();
  expect(current.focus).toBe("left_hand");
});

test.afterEach(async ({ page }, testInfo) => {
  const record = evidence.get(page)!;
  await testInfo.attach("public-generic-inputs-and-poses", { body: JSON.stringify(record, null, 2), contentType: "application/json" });
  if (!page.isClosed()) {
    const path = testInfo.outputPath("avatar-support-final.png");
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("avatar-support-final", { path, contentType: "image/png" });
  }
  expect(record.errors).toEqual([]);
});

async function direct(page: Page, instruction: string, expected: string, focus = "body") {
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
  expect(result.output).toBe(expected);
  await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled({ timeout: 180_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await state(page);
  expect(current.character).toBe("jade");
  expect(current.program.dance?.style).not.toBe("gangnam");
  expect(current.focus).toBe(focus);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline), { timeout: 30_000 }).toEqual(compileMotion(current.program));
  await expect.poll(() => page.evaluate(() => (window as any).__motion.cameraSnapshot().transitioning)).toBe(false);
  return current;
}

async function assertSupport(page: Page, side: "left" | "right") {
  const samples = await page.evaluate(() => {
    const studio = (window as any).__motionStudio, motion = (window as any).__motion;
    return [.2, .5, .8].map(fraction => {
      const time = motion.timeline.duration * fraction;
      studio.seek(time); motion.seek(time);
      return { time, pose: motion.snapshot(), camera: motion.cameraSnapshot() };
    });
  });
  evidence.get(page)!.samples.push(...samples);
  const free = side === "left" ? "right" : "left";
  for (const { pose } of samples) {
    expect(pose[`${side}_ankle`].position[1], "The supporting foot stays near the floor.").toBeLessThan(.15);
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

test("ordinary avatar leg lift and opposite-foot follow-ups preserve the hand showcase", async ({ page }) => {
  const original = await state(page);
  expect(original.program.props).toHaveLength(1);
  const lifted = await direct(page, "Lift left leg", "support right");
  assertUpperBodyPreserved(original.program, lifted.program);
  await assertSupport(page, "right");
  const switched = await direct(page, "Switch to the opposite foot.", "support other");
  assertUpperBodyPreserved(original.program, switched.program);
  await assertSupport(page, "left");
  const restored = await direct(page, "Both feet again.", "support both");
  expect(restored.program).toEqual(original.program);
});

test("a fresh avatar accepts Chinese leg directions and an independent finger wiggle", async ({ page }) => {
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  const original = await state(page);
  const lifted = await direct(page, "抬左腿", "support right");
  assertUpperBodyPreserved(original.program, lifted.program);
  await assertSupport(page, "right");
  const finger = await direct(page, "Wiggle only the left index finger 65 degrees", "wiggle left_index_1 z 65", "left_hand");
  expect(finger.selectedTargets).toContain("left_index_1");
  expect(compileMotion(finger.program).tracks.some(track => track.target === "left_index_1" && track.curve.kind === "sine")).toBe(true);
  await assertSupport(page, "right");
});

test("salsa can balance on one foot and restore its own footwork without selecting Gangnam", async ({ page }) => {
  const salsa = await direct(page, "Dance salsa", "dance salsa");
  const balanced = await direct(page, "Balance on your left foot.", "support left");
  assertUpperBodyPreserved(salsa.program, balanced.program);
  await assertSupport(page, "left");
  const restored = await direct(page, "Both feet again.", "support both");
  expect(restored.program).toEqual(salsa.program);
});
