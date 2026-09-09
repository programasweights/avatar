import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { CurveNode, MotionNode, MotionProgram } from "../src/motion/types";
import { compileMotion } from "../src/motion/engine";

// Exercise the real UI and skinned rig without hosted model calls. This small
// motion makes a selected finger and its independently moving neighbour easy
// to distinguish, without relying on a particular showcase's nested IDs.
const curl = (
  id: string,
  target: string,
  amplitude: number,
  phase = -0.25,
): CurveNode => ({
  id,
  label: target,
  kind: "curve",
  target,
  channel: "rotation",
  axis: "z",
  duration: 4,
  curve: { kind: "sine", amplitude, offset: amplitude, cycles: 1, phase },
});
const fixture: MotionProgram = {
  version: 2,
  title: "Interaction controls",
  bpm: 120,
  root: {
    kind: "parallel",
    id: "interaction",
    label: "Independent fingers",
    children: [
      {
        kind: "parallel",
        id: "test.left.index",
        label: "Left index",
        children: [
          curl("test.index.base", "left_index_1", 32),
          curl("test.index.middle", "left_index_2", 22),
          curl("test.index.tip", "left_index_3", 14),
        ],
      },
      curl("test.middle.base", "left_middle_1", 25, -0.1),
      curl("test.right.base", "right_index_1", -28),
    ],
  },
};
const indexTargets = ["left_index_1", "left_index_2", "left_index_3"];
const sampleTimes = [0.2, 1, 2.2, 3.2];
type Pose = Record<string, { position: number[]; quaternion: number[] }>;

test.use({
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  },
});

async function ready(page: Page, useFixture = true) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Studio page error:", error.message);
  });
  // Keep a single build loaded when another developer is editing the studio.
  await page.routeWebSocket("**", () => {});
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(
    () => !!(window as any).__motion && !!(window as any).__motionStudio,
    undefined,
    { timeout: 60_000 },
  );
  if (useFixture) {
    await importMotion(page, fixture);
  }
  await seek(page, 0);
  return errors;
}
async function importMotion(page: Page, motion: MotionProgram) {
  const edit = page.locator("summary").filter({ hasText: "Edit motion" });
  if (
    !(await edit
      .locator("..")
      .evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await edit.click();
  await page
    .getByRole("button", { name: "Edit motion JSON", exact: true })
    .click();
  await page
    .getByLabel("Motion JSON", { exact: true })
    .fill(JSON.stringify(motion));
  await page
    .getByRole("button", { name: "Apply program", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect.poll(() => program(page)).toEqual(motion);
}
async function seek(page: Page, time: number) {
  await page.waitForFunction(
    () => !!(window as any).__motionStudio && !!(window as any).__motion,
  );
  await page.evaluate(
    (time) => (window as any).__motionStudio.seek(time),
    time,
  );
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.waitForFunction(() => !!(window as any).__motion);
  await page.evaluate((time) => (window as any).__motion.seek(time), time);
}
async function program(page: Page): Promise<MotionProgram> {
  return page.evaluate(() => (window as any).__motionStudio.snapshot().program);
}
async function poses(page: Page, times = sampleTimes): Promise<Pose[]> {
  // React DOM commits and the R3F root commit separately. Wait until the visible
  // actor has received the newly edited timeline before inspecting its pose.
  const expected = JSON.stringify(compileMotion(await program(page)));
  await page.waitForFunction(
    (expected) =>
      JSON.stringify((window as any).__motion?.timeline) === expected,
    expected,
  );
  return page.evaluate(
    (times) =>
      times.map((time) => {
        const motion = (window as any).__motion;
        motion.seek(time);
        return motion.snapshot();
      }),
    times,
  );
}
function sameJoint(
  actual: Pose[string],
  expected: Pose[string],
  message: string,
) {
  actual.position.forEach((value, index) =>
    expect(value, `${message} position`).toBeCloseTo(
      expected.position[index],
      7,
    ),
  );
  // Quaternion signs are equivalent rotations. Compare the absolute dot product.
  const dot = normalizedDot(actual.quaternion, expected.quaternion);
  expect(dot, `${message} rotation`).toBeCloseTo(1, 7);
}
function rotationDifference(a: Pose[string], b: Pose[string]) {
  return 1 - normalizedDot(a.quaternion, b.quaternion);
}
function normalizedDot(a: number[], b: number[]) {
  return (
    Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)) /
    (Math.hypot(...a) * Math.hypot(...b))
  );
}
function node(root: MotionNode, id: string): MotionNode | undefined {
  if (root.id === id) return root;
  if (root.kind === "curve" || root.kind === "contact") return undefined;
  for (const child of root.children) {
    const found = node(child, id);
    if (found) return found;
  }
}
function selected(page: Page, id: string) {
  return page.locator(`.live-tree-select[data-node-id="${id}"]`);
}
async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    content: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 2);
}

test("selecting a finger highlights its actual joints, pauses only that finger, and restores its animation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await ready(page);
  const original = await program(page);
  const baseline = await poses(page);
  const heldTime = 1;
  await seek(page, heldTime);
  const held = (await poses(page, [heldTime]))[0];
  await selected(page, "test.left.index").click();
  await expect(selected(page, "test.left.index")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__motion.cameraSnapshot().focus),
    )
    .toBe("left_hand");
  await seek(page, heldTime);
  const markers = await page.evaluate(() =>
    (window as any).__motion.selectionSnapshot(),
  );
  expect(markers.map((marker: any) => marker.target).sort()).toEqual(
    indexTargets,
  );
  for (const marker of markers)
    marker.position.forEach((value: number, axis: number) =>
      expect(value).toBeCloseTo(held[marker.target].position[axis], 7),
    );

  await page.getByRole("button", { name: "Pause finger", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore motion", exact: true }),
  ).toBeVisible();
  const frozen = await poses(page);
  frozen.forEach((pose, sample) => {
    for (const target of indexTargets)
      sameJoint(
        pose[target],
        held[target],
        `${target} held at ${sampleTimes[sample]}`,
      );
    for (const target of [
      "left_middle_1",
      "right_index_1",
      "left_wrist",
      "left_ankle",
      "right_ankle",
    ])
      sameJoint(
        pose[target],
        baseline[sample][target],
        `${target} preserved at ${sampleTimes[sample]}`,
      );
  });
  expect(
    rotationDifference(frozen[0].left_middle_1, frozen[1].left_middle_1),
    "The neighbouring finger must still animate",
  ).toBeGreaterThan(0.01);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore motion", exact: true }),
  ).toHaveCount(0);
  expect(await program(page)).toEqual(original);
  await seek(page, heldTime);
  await page.getByRole("button", { name: "Pause finger", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore motion", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Restore motion", exact: true })
    .click();
  expect(await program(page)).toEqual(original);
  const restored = await poses(page);
  restored.forEach((pose, sample) =>
    indexTargets.forEach((target) =>
      sameJoint(pose[target], baseline[sample][target], `${target} restored`),
    ),
  );
  expect(
    rotationDifference(restored[0].left_index_1, restored[2].left_index_1),
  ).toBeGreaterThan(0.01);

  await selected(page, "test.right.base").click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__motion.cameraSnapshot().focus),
    )
    .toBe("right_hand");
  await seek(page, 0.5);
  expect(
    await page.evaluate(() =>
      (window as any).__motion
        .selectionSnapshot()
        .map((marker: any) => marker.target),
    ),
  ).toEqual(["right_index_1"]);
  expect(errors).toEqual([]);
});

test("editing a selected curl changes only its leaf and undo restores the original motion", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await ready(page);
  await selected(page, "test.left.index").click();
  await selected(page, "test.index.base").click();
  const original = await program(page);
  const baseline = await poses(page, [1]);
  const originalAmount = await page
    .getByLabel("Curl amount", { exact: true })
    .inputValue();
  await page.getByLabel("Curl amount", { exact: true }).fill("20");
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "20",
  );
  const changed = await program(page);
  const beforeLeaf = node(original.root, "test.index.base") as CurveNode;
  const changedLeaf = node(changed.root, "test.index.base") as CurveNode;
  expect(changedLeaf.curve).not.toEqual(beforeLeaf.curve);
  expect(changedLeaf).toEqual({ ...beforeLeaf, curve: changedLeaf.curve });
  for (const id of [
    "test.index.middle",
    "test.index.tip",
    "test.middle.base",
    "test.right.base",
  ])
    expect(node(changed.root, id), `${id} must not change`).toEqual(
      node(original.root, id),
    );
  const after = (await poses(page, [1]))[0];
  expect(
    rotationDifference(after.left_index_1, baseline[0].left_index_1),
  ).toBeGreaterThan(0.001);
  sameJoint(
    after.left_middle_1,
    baseline[0].left_middle_1,
    "Neighbour after curl edit",
  );
  sameJoint(
    after.right_index_1,
    baseline[0].right_index_1,
    "Opposite hand after curl edit",
  );
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    originalAmount,
  );
  expect(await program(page)).toEqual(original);
  const restored = (await poses(page, [1]))[0];
  for (const target of indexTargets)
    sameJoint(restored[target], baseline[0][target], `${target} undo`);
  await page.getByLabel("Curl amount", { exact: true }).fill("0");
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "0",
  );
  await page.getByRole("button", { name: "Undo edit", exact: true }).focus();
  await page.getByLabel("Curl amount", { exact: true }).fill("65");
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "65",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  const recovered = node(
    (await program(page)).root,
    "test.index.base",
  ) as CurveNode;
  expect(recovered.curve).toEqual({
    kind: "sine",
    amplitude: 32.5,
    offset: 32.5,
    cycles: 1,
    phase: -0.25,
  });
  const moving = await poses(page);
  expect(
    rotationDifference(moving[0].left_index_1, moving[2].left_index_1),
  ).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});

test("new skills and JSON replacement release old pauses without hidden frozen rotations", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await ready(page, false);
  await page
    .getByRole("button", { name: "Finger ripple", exact: true })
    .click();
  await selected(page, "ripple.left.index").click();
  await seek(page, 1);
  await page.getByRole("button", { name: "Pause finger", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore motion", exact: true }),
  ).toBeVisible();
  await page.route("**/api/direct", (route) =>
    route.fulfill({ json: { output: "skill finger_ripple left forward" } }),
  );
  await page
    .getByLabel("Direction", { exact: true })
    .fill("Make a finger ripple");
  await page.getByRole("button", { name: "Direct", exact: true }).click();
  await expect(page.locator(".motion-stage-label")).toHaveText(
    "PAW · neural commands",
  );
  expect(
    await page.evaluate(() => (window as any).__motionStudio.snapshot().frozen),
  ).toEqual([]);
  expect(JSON.stringify(await program(page))).not.toContain("editing.freeze");
  // A ripple finger moves only briefly within the phrase. Cover the complete
  // cycle so resting intervals cannot masquerade as a leftover pause.
  const duration = compileMotion(await program(page)).duration;
  const moving = await poses(
    page,
    Array.from({ length: 25 }, (_, index) => (duration * index) / 25),
  );
  expect(
    Math.max(
      ...moving.map((pose) =>
        rotationDifference(pose.left_index_1, moving[0].left_index_1),
      ),
    ),
  ).toBeGreaterThan(0.01);

  await importMotion(page, fixture);
  await selected(page, "test.left.index").click();
  await page.getByRole("button", { name: "Pause finger", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restore motion", exact: true }),
  ).toBeVisible();
  await importMotion(page, fixture);
  expect(
    await page.evaluate(() => (window as any).__motionStudio.snapshot().frozen),
  ).toEqual([]);
  await selected(page, "test.left.index").click();
  await expect(
    page.getByRole("button", { name: "Pause finger", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore motion", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an implicit language pause follows the selected right hand and preserves the left finger", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = await ready(page);
  const baseline = await poses(page);
  await selected(page, "test.right.base").click();
  await seek(page, 1);
  const held = (await poses(page, [1]))[0];
  await page.route("**/api/direct", (route) =>
    route.fulfill({ json: { output: "freeze index" } }),
  );
  await page
    .getByLabel("Direction", { exact: true })
    .fill("Pause the index finger");
  await page.getByRole("button", { name: "Direct", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__motionStudio
          .snapshot()
          .frozen.flatMap((token: any) => token.targets)
          .sort(),
      ),
    )
    .toEqual(["right_index_1", "right_index_2", "right_index_3"]);
  const frozen = await poses(page);
  frozen.forEach((pose, sample) => {
    for (const target of ["right_index_1", "right_index_2", "right_index_3"])
      sameJoint(pose[target], held[target], `${target} paused`);
    sameJoint(
      pose.left_index_1,
      baseline[sample].left_index_1,
      "Left finger preserved",
    );
  });
  expect(errors).toEqual([]);
});

test("recording view keeps playback and capture usable and produces a video", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors = await ready(page);
  await page
    .getByRole("button", { name: "Recording view", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Exit recording view", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Live motion tree", exact: true }),
  ).not.toBeVisible();
  await expect(page.getByLabel("Direction", { exact: true })).not.toBeVisible();
  await expect(
    page.getByRole("region", { name: "Avatar preview", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".motion-caption p")).toBeVisible();
  await noHorizontalOverflow(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Record video", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeVisible();
  // The animation clock can advance by one slow software-rendered frame before
  // the video encoder starts. Give the real encoder one second of wall time.
  const started = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    (started) => performance.now() - started >= 1_000,
    started,
  );
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
  const output = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(output);
  const bytes = await readFile(output);
  expect(
    bytes.length,
    "A real encoded recording should be downloaded",
  ).toBeGreaterThan(1_000);
  const dimensions = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const url = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
    const video = document.createElement("video");
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () =>
          reject(new Error("Recorded video cannot be decoded"));
        video.src = url;
      });
      return { width: video.videoWidth, height: video.videoHeight };
    } finally {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }, bytes.toString("base64"));
  expect(dimensions).toEqual({ width: 1080, height: 1080 });
  await page
    .getByRole("button", { name: "Exit recording view", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Live motion tree", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Direction", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the compact tree, selected controls and recording view remain reachable on mobile", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await ready(page);
  const tree = page.getByRole("region", {
    name: "Live motion tree",
    exact: true,
  });
  await expect(tree).toBeVisible();
  await selected(page, "test.left.index").click();
  await expect(
    page.getByRole("button", { name: "Pause finger", exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await selected(page, "test.index.base").click();
  await page.getByLabel("Curl amount", { exact: true }).fill("25");
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "25",
  );
  await noHorizontalOverflow(page);
  await page
    .getByRole("button", { name: "Recording view", exact: true })
    .click();
  await expect(tree).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record video", exact: true }),
  ).toBeVisible();
  await noHorizontalOverflow(page);
  await page
    .getByRole("button", { name: "Exit recording view", exact: true })
    .click();
  await expect(tree).toBeVisible();
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "25",
  );
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});
