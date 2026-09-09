import { expect, test, type Page } from "@playwright/test";
import { createBodyAction } from "../src/motion/bodyActions";
import { compileMotion } from "../src/motion/engine";
import { PerspectiveCamera, Vector3 } from "three";

test.use({
  viewport: { width: 1280, height: 960 },
  video: "on",
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  },
});
const snapshot = (page: Page) =>
  page.evaluate(() => (window as any).__motionStudio.snapshot());
const live = process.env.AVATAR_LIVE_PUBLIC === "1";
const expectedOutputs = new WeakMap<Page, Record<string, string>>();
async function ready(page: Page, outputs: Record<string, string>) {
  expectedOutputs.set(page, outputs);
  await page.routeWebSocket("**", () => {});
  if (!live) {
    await page.route(/\/api\/(?:v1\/avatar\/)?direct$/, (route) => {
      const instruction = route.request().postDataJSON().instruction;
      expect(Object.hasOwn(outputs, instruction), instruction).toBe(true);
      return route.fulfill({ json: { output: outputs[instruction] } });
    });
  }
  await page.goto(
    live
      ? "https://programasweights.com/avatar?dbg=1&quality=low"
      : "/?dbg=1&quality=low",
  );
  await page.waitForFunction(
    () => !!(window as any).__motionStudio && !!(window as any).__motion,
  );
}
async function direct(page: Page, instruction: string) {
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const response = page.waitForResponse((response) =>
    /\/api\/(?:v1\/avatar\/)?direct$/.test(response.url()),
  );
  await page
    .getByRole("button", { name: "Apply direction", exact: true })
    .click();
  const result = await response;
  const body = await result.json();
  expect(result.status(), JSON.stringify(body)).toBe(200);
  expect(body.output, instruction).toBe(
    expectedOutputs.get(page)![instruction],
  );
  await test.info().attach(`${live ? "live" : "mock"}-${instruction}`, {
    body: JSON.stringify({ instruction, response: body }, null, 2),
    contentType: "application/json",
  });
  await expect(
    page.getByRole("button", { name: "Apply direction", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.locator(".motion-stage").scrollIntoViewIfNeeded();
  // Seeking cancels an in-flight camera transition. Let the actual hand-to-body
  // transition finish first, just as it does during ordinary playback.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const camera = (window as any).__motion.cameraSnapshot();
          return (
            camera.focus === "body" &&
            !camera.transitioning &&
            Math.abs(camera.position[0] - 2.5) < 0.001 &&
            Math.abs(camera.position[2] - 4.5) < 0.001
          );
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
}
async function seek(page: Page, time: number) {
  const result = await page.evaluate((time) => {
    (window as any).__motionStudio.seek(time);
    (window as any).__motion.seek(time);
    return {
      joints: (window as any).__motion.snapshot(),
      props: (window as any).__motion.rig.props.snapshot(),
      camera: (window as any).__motion.cameraSnapshot(),
    };
  }, time);
  const box = await page.locator(".motion-stage canvas").boundingBox();
  const camera = new PerspectiveCamera(30, box!.width / box!.height, 0.1, 1000);
  camera.position.fromArray(result.camera.position);
  camera.up.fromArray(result.camera.up);
  camera.lookAt(new Vector3().fromArray(result.camera.target));
  camera.updateMatrixWorld();
  for (const [target, pose] of Object.entries(result.joints) as [
    string,
    { position: number[] },
  ][]) {
    const screen = new Vector3().fromArray(pose.position).project(camera);
    expect(Math.abs(screen.x), `${target} horizontal framing`).toBeLessThan(
      0.95,
    );
    expect(Math.abs(screen.y), `${target} vertical framing`).toBeLessThan(0.95);
  }
  return result;
}

test("run, jump twice and bow visibly replace the hand demo and honor finite playback", async ({
  page,
}, testInfo) => {
  test.setTimeout(live ? 240_000 : 120_000);
  await ready(page, {
    Run: "action run 1",
    "Jump twice": "action jump 2",
    Bow: "action bow 1",
  });
  await direct(page, "Run");
  let state = await snapshot(page);
  expect(state.program).toEqual(createBodyAction("run"));
  expect(state.loop).toBe(true);
  expect(state.focus).toBe("body");
  expect(state.cues).toEqual([]);
  const running = await seek(page, 0.3);
  expect(running.props).toEqual({});
  const runPath = testInfo.outputPath("run.png");
  await page.locator(".motion-stage").screenshot({ path: runPath });
  await testInfo.attach("run", { path: runPath, contentType: "image/png" });
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  await page.waitForTimeout(2500);

  await direct(page, "Jump twice");
  state = await snapshot(page);
  expect(state.program).toEqual(createBodyAction("jump", 2));
  expect(state.loop).toBe(false);
  const duration = compileMotion(state.program).duration;
  const ground = await seek(page, 0),
    apex = await seek(page, (duration / 2) * 0.44);
  expect(
    apex.joints.left_ankle.position[1] - ground.joints.left_ankle.position[1],
  ).toBeGreaterThan(0.3);
  expect(
    apex.joints.right_ankle.position[1] - ground.joints.right_ankle.position[1],
  ).toBeGreaterThan(0.3);
  const jumpPath = testInfo.outputPath("jump-apex.png");
  await page.locator(".motion-stage").screenshot({ path: jumpPath });
  await testInfo.attach("jump-apex", {
    path: jumpPath,
    contentType: "image/png",
  });
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).playing, { timeout: 20_000 })
    .toBe(false);
  expect((await snapshot(page)).time).toBeCloseTo(duration, 3);
  expect((await snapshot(page)).program).toEqual(state.program);

  await direct(page, "Bow");
  state = await snapshot(page);
  expect(state.loop).toBe(false);
  expect(state.focus).toBe("body");
  const bowed = await seek(page, compileMotion(state.program).duration * 0.5);
  expect(bowed.joints.head.position[2]).toBeGreaterThan(
    ground.joints.head.position[2] + 0.3,
  );
  const bowPath = testInfo.outputPath("bow.png");
  await page.locator(".motion-stage").screenshot({ path: bowPath });
  await testInfo.attach("bow", { path: bowPath, contentType: "image/png" });
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).playing, { timeout: 20_000 })
    .toBe(false);
});

test("common body poses stay framed and chained actions retain the whole sequence", async ({
  page,
}, testInfo) => {
  test.setTimeout(live ? 300_000 : 120_000);
  await ready(page, {
    Walk: "action walk 1",
    Crouch: "action crouch 1",
    "Sit down": "action sit 1",
    "Kick left": "action kick_left 1",
    "Turn right": "action turn_right 1",
    Spin: "action spin 1",
    "Walk and wave then bow": "action walk_wave 1\naction bow 1",
    "Run then jump twice": "action run 1\naction jump 2",
  });
  for (const instruction of [
    "Walk",
    "Crouch",
    "Sit down",
    "Kick left",
    "Turn right",
    "Spin",
    "Walk and wave then bow",
  ]) {
    await direct(page, instruction);
    const state = await snapshot(page),
      timeline = compileMotion(state.program);
    expect(state.focus).toBe("body");
    await seek(
      page,
      instruction === "Sit down"
        ? timeline.duration
        : timeline.duration *
            (instruction === "Walk and wave then bow" ? 0.2 : 0.5),
    );
    const path = testInfo.outputPath(
      `${instruction.toLowerCase().replaceAll(" ", "-")}.png`,
    );
    await page.locator(".motion-stage").screenshot({ path });
    await testInfo.attach(instruction, { path, contentType: "image/png" });
  }
  await direct(page, "Run then jump twice");
  const state = await snapshot(page);
  expect(state.program.root.id).toBe("body_sequence");
  expect(
    state.program.root.children
      .find((node: any) => node.id === "body_phases")
      .children.map((node: any) => node.id),
  ).toEqual([
    "body_step.0.motion",
    "body_transition.1",
    "body_step.1.body_action",
  ]);
  expect(state.loop).toBe(false);
  const before = state.program;
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).playing, { timeout: 20_000 })
    .toBe(false);
  expect((await snapshot(page)).program).toEqual(before);
});
