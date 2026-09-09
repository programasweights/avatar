import { expect, test, type Page } from "@playwright/test";
import { compileMotion, sampleTimeline } from "../src/motion/engine";
import { currentMotionHand } from "../src/motion/relative";
import {
  createDexteritySequence,
  getDexteritySequenceInstructions,
  defaultDexteritySequenceCommands,
} from "../src/motion/dexteritySequence";

// Real studio and published rig, with controlled neural responses. The separate
// opt-in language suite verifies that the finetuned programs emit these commands.
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

async function ready(page: Page, outputs: Record<string, string>) {
  await page.routeWebSocket("**", () => {});
  await page.route("**/api/direct", (route) => {
    const text = route.request().postDataJSON().instruction;
    expect(Object.hasOwn(outputs, text), `Unexpected inference: ${text}`).toBe(
      true,
    );
    return route.fulfill({ json: { output: outputs[text] } });
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(
    () => !!(window as any).__motionStudio && !!(window as any).__motion,
  );
}
const snapshot = (page: Page) =>
  page.evaluate(() => (window as any).__motionStudio.snapshot());
async function direct(page: Page, text: string) {
  await page.getByLabel("Direction", { exact: true }).fill(text);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/direct"));
  await page
    .getByRole("button", { name: "Apply direction", exact: true })
    .click();
  await response;
  await expect(
    page.getByRole("button", { name: "Apply direction", exact: true }),
  ).toBeEnabled();
}
async function seek(page: Page, time: number) {
  await page.evaluate((t) => {
    (window as any).__motionStudio.seek(t);
    (window as any).__motion.seek(t);
  }, time);
}

test("the full showcase supports other-hand and reversal without loading a different example", async ({
  page,
}) => {
  await ready(page, {
    "Use the other hand": "hand other",
    "Reverse it": "reverse current",
  });
  await seek(page, 12);
  const before = await snapshot(page);
  await direct(page, "Use the other hand");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const mirrored = await snapshot(page);
  expect(currentMotionHand(mirrored.program)).toBe("right");
  expect(mirrored.focus).toBe("right_hand");
  expect(mirrored.program.props).toEqual(before.program.props);
  expect(compileMotion(mirrored.program).duration).toBeCloseTo(
    compileMotion(before.program).duration,
    8,
  );
  expect(mirrored.time).toBeGreaterThan(11.9);
  await direct(page, "Reverse it");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const reversed = await snapshot(page);
  expect(reversed.time).toBeLessThan(1);
  expect(currentMotionHand(reversed.program)).toBe("right");
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  expect((await snapshot(page)).program).toEqual(reversed.program);
  await direct(page, "Reverse it");
  const restored = compileMotion((await snapshot(page)).program);
  const original = compileMotion(mirrored.program);
  for (const fraction of [0.1, 0.4, 0.75, 0.9]) {
    const values = (t: typeof original) =>
      sampleTimeline(t, fraction * t.duration)
        .map((v) => [v.target, v.channel, v.axis, Number(v.value.toFixed(7))])
        .sort((a, b) => String(a).localeCompare(String(b)));
    expect(values(restored)).toEqual(values(original));
  }
});

test("other hand follows choreography even after a right-leg edit changes the inspector", async ({
  page,
}) => {
  await ready(page, {
    "Lift right leg": "joint right_hip x -45",
    "Use the other hand": "hand other",
  });
  await page.getByRole("button", { name: "Coin roll", exact: true }).click();
  await direct(page, "Lift right leg");
  const before = await snapshot(page);
  expect(before.selectedTargets).toContain("right_hip");
  expect(currentMotionHand(before.program)).toBe("left");
  await direct(page, "Use the other hand");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const after = await snapshot(page);
  expect(currentMotionHand(after.program)).toBe("right");
  const legTracks = (program: any) =>
    compileMotion(program).tracks.filter((t) =>
      /_(hip|knee|ankle|foot_ik)$/.test(t.target),
    );
  expect(legTracks(after.program)).toEqual(legTracks(before.program));
});

test("example loaders use the same hand shown in their control after inspecting the opposite leg", async ({
  page,
}) => {
  const directions = getDexteritySequenceInstructions("left");
  const commands = defaultDexteritySequenceCommands("left");
  await ready(page, {
    "Lift right leg": "joint right_hip x -30",
    ...Object.fromEntries(directions.map((text, i) => [text, commands[i]])),
  });
  await direct(page, "Lift right leg");
  await page
    .getByRole("button", { name: "Fingertip touches", exact: true })
    .click();
  expect((await snapshot(page)).focus).toBe("left_hand");
  await direct(page, "Lift right leg");
  await page.locator("summary").filter({ hasText: "More motions" }).click();
  await expect(page.getByLabel("Dexterity hand", { exact: true })).toHaveValue(
    "left",
  );
  await page
    .getByRole("button", { name: "Recreate demo from prompts", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page)).program)
    .toEqual(createDexteritySequence().program);
  await expect
    .poll(async () => (await snapshot(page)).origin)
    .toBe("Your motion");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await snapshot(page)).program).toEqual(
    createDexteritySequence().program,
  );
  expect((await snapshot(page)).focus).toBe("left_hand");
});

test("an unnamed finger follows the performing hand after inspecting the other leg", async ({
  page,
}) => {
  await ready(page, {
    "Lift right leg": "joint right_hip x -30",
    "Pause index": "freeze index",
    "Restore index": "restore index",
  });
  await page
    .getByRole("button", { name: "Finger ripple", exact: true })
    .click();
  await direct(page, "Lift right leg");
  await seek(page, 1);
  const before = await snapshot(page);
  expect(before.selectedTargets).toContain("right_hip");
  await direct(page, "Pause index");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    (await snapshot(page)).frozen.flatMap((token: any) => token.targets).sort(),
  ).toEqual(["left_index_1", "left_index_2", "left_index_3"]);
  await direct(page, "Lift right leg");
  await direct(page, "Restore index");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await snapshot(page)).frozen).toHaveLength(0);
});

test("paused fingers survive a hand switch and exact speed change, then restore and undo", async ({
  page,
}) => {
  await ready(page, {
    "Pause index": "freeze left_index",
    "Use right hand": "hand right",
    "Double speed": "tempo_scale 2",
    "Restore index": "restore index",
  });
  await page
    .getByRole("button", { name: "Finger ripple", exact: true })
    .click();
  await seek(page, 1);
  await direct(page, "Pause index");
  const paused = await snapshot(page);
  expect(paused.frozen).toHaveLength(3);
  await direct(page, "Use right hand");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const mirrored = await snapshot(page);
  expect(mirrored.frozen.flatMap((t: any) => t.targets).sort()).toEqual([
    "right_index_1",
    "right_index_2",
    "right_index_3",
  ]);
  expect(mirrored.focus).toBe("right_hand");
  await direct(page, "Double speed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const faster = await snapshot(page);
  expect(faster.program.bpm).toBe(paused.program.bpm * 2);
  faster.frozen.forEach((token: any, i: number) =>
    expect(token.time).toBeCloseTo(paused.frozen[i].time / 2, 8),
  );
  await direct(page, "Restore index");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await snapshot(page)).frozen).toHaveLength(0);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await snapshot(page)).program).toEqual(faster.program);
  expect((await snapshot(page)).frozen).toEqual(faster.frozen);
  expect((await snapshot(page)).focus).toBe("right_hand");
});

test("unsupported tricks and out-of-range speed preserve the visible creation", async ({
  page,
}) => {
  await ready(page, {
    "Roll a coin on your head": "unsupported",
    "Four times faster": "tempo_scale 4",
  });
  await seek(page, 13);
  await expect
    .poll(async () => (await snapshot(page)).caption)
    .toBe("Roll a coin across your left knuckles.");
  const before = await snapshot(page);
  await direct(page, "Roll a coin on your head");
  await expect(page.getByRole("alert")).toBeVisible();
  const rejected = await snapshot(page);
  expect(rejected.program).toEqual(before.program);
  expect(rejected.caption).toBe(before.caption);
  expect(rejected.time).toBe(before.time);
  await direct(page, "Four times faster");
  await expect(page.getByRole("alert")).toContainText(/30|240/);
  expect((await snapshot(page)).program).toEqual(before.program);
});

test("the hand and reverse controls edit the current finger curves without reloading the study", async ({
  page,
}) => {
  await ready(page, { "Bend index 25": "joint left_index_1 z 25" });
  await page
    .getByRole("button", { name: "Finger ripple", exact: true })
    .click();
  await direct(page, "Bend index 25");
  const before = await snapshot(page);
  await page.locator("summary").filter({ hasText: "More motions" }).click();
  await page
    .getByLabel("Dexterity hand", { exact: true })
    .selectOption("right");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const right = await snapshot(page);
  expect(currentMotionHand(right.program)).toBe("right");
  expect(right.selected).toBe(before.selected);
  expect(right.selectedTargets).toEqual(["right_index_1"]);
  expect(
    compileMotion(right.program).tracks.find((t) => t.id === before.selected)
      ?.curve,
  ).toEqual({ kind: "constant", value: -25 });
  await page
    .getByRole("button", { name: "Reverse dexterity motion", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const reversed = await snapshot(page);
  expect(
    compileMotion(reversed.program).tracks.find((t) => t.id === before.selected)
      ?.curve,
  ).toEqual({ kind: "constant", value: -25 });
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await snapshot(page)).program).toEqual(right.program);
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  expect((await snapshot(page)).program).toEqual(before.program);
  expect((await snapshot(page)).focus).toBe("left_hand");
});

test("left waving selects the left arm and preserves the actual right-arm pose", async ({
  page,
}) => {
  await ready(page, { "Wave with your left hand": "wave left" });
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await seek(page, 0.5);
  const before = await page.evaluate(() => (window as any).__motion.snapshot());
  await direct(page, "Wave with your left hand");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await seek(page, 0.5);
  const after = await page.evaluate(() => (window as any).__motion.snapshot());
  const studio = await snapshot(page);
  expect(currentMotionHand(studio.program)).toBe("left");
  expect(studio.focus).toBe("body");
  expect(studio.selectedTargets).toContain("left_wrist");
  expect(after.left_shoulder.quaternion).not.toEqual(
    before.left_shoulder.quaternion,
  );
  for (const target of [
    "right_shoulder",
    "right_elbow",
    "right_wrist",
    "left_ankle",
    "right_ankle",
  ])
    for (const field of ["position", "quaternion"])
      after[target][field].forEach((value: number, i: number) =>
        expect(value).toBeCloseTo(before[target][field][i], 6),
      );
});

test("editing either finger after a hand switch keeps selection and both independent details", async ({
  page,
}) => {
  await ready(page, {
    "Wiggle left index": "wiggle left_index_1 z 65",
    "Other hand": "hand other",
    "Bend right index": "joint right_index_1 z -30",
    "Bend left index": "joint left_index_1 z 20",
  });
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await direct(page, "Wiggle left index");
  await direct(page, "Other hand");
  await direct(page, "Bend right index");
  let state = await snapshot(page);
  expect(state.selectedTargets).toEqual(["right_index_1"]);
  expect(state.focus).toBe("right_hand");
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "30",
  );
  await direct(page, "Bend left index");
  state = await snapshot(page);
  expect(state.selectedTargets).toEqual(["left_index_1"]);
  expect(state.focus).toBe("left_hand");
  await expect(page.getByLabel("Curl amount", { exact: true })).toHaveValue(
    "20",
  );
  const tracks = compileMotion(state.program).tracks.filter((track) =>
    track.id.startsWith("detail."),
  );
  expect(tracks).toHaveLength(2);
  expect(
    tracks.find((track) => track.target === "right_index_1")?.curve,
  ).toEqual({ kind: "constant", value: -30 });
  expect(
    tracks.find((track) => track.target === "left_index_1")?.curve,
  ).toEqual({ kind: "constant", value: 20 });
});
