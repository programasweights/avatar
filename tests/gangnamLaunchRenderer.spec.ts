import { expect, test } from "@playwright/test";

const instructions = [
  "Dance Gangnam Style.",
  "Now on one foot.",
  "Switch to the opposite foot.",
];

test.use({
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] },
});

test("the launch keeps its camera fixed, its whole character visible, and its captions aligned with edits", async ({ page }) => {
  await page.goto("/tools/dance-renderer.html");
  await page.waitForFunction(() => !!(window as any).__sequence);
  const result = await page.evaluate(() => {
    const renderer = (window as any).__sequence;
    const initialized = renderer.initialize(undefined, "left", "sequence");
    const [left, right] = initialized.launch.edits;
    const times = [
      0, left.start - 0.001, left.start, left.settled,
      3.787878787878788, // Raised-fist maximum in the original choreography.
      right.start - 0.001, right.start, right.settled, initialized.duration,
    ];
    return {
      duration: initialized.duration, inputBox: initialized.inputBox,
      cues: initialized.cues, edits: initialized.launch.edits,
      frames: times.map((time) => ({ time, ...renderer.inspect(time, true) })),
    };
  });
  expect(result.duration).toBeCloseTo(20 * 60 / 132, 10);
  expect(result.cues.map((cue: any) => cue.instruction)).toEqual(instructions);
  expect(result.frames[0].camera.type).toBe("OrthographicCamera");
  expect(result.frames[0].camera.viewHeight).toBeGreaterThan(0);
  for (const frame of result.frames) {
    expect(frame.camera).toEqual(result.frames[0].camera);
    const expected = frame.time < result.edits[0].start ? 0 : frame.time < result.edits[1].start ? 1 : 2;
    expect(frame.cue).toBe(instructions[expected]);
    expect(frame.interaction).toBeNull(); // The uncaptured preview must also tell the same story.
    expect(frame.frameBounds.minX).toBeGreaterThanOrEqual(12);
    expect(frame.frameBounds.maxX).toBeLessThanOrEqual(1068);
    expect(frame.frameBounds.minY).toBeGreaterThanOrEqual(5);
    expect(frame.frameBounds.maxY).toBeLessThanOrEqual(result.inputBox.y - 8);
    const support = frame.time >= result.edits[1].settled ? "right"
      : frame.time >= result.edits[0].settled && frame.time < result.edits[1].start ? "left" : undefined;
    if (support) {
      const free = support === "left" ? "right" : "left";
      expect(frame.joints[`${free}_ankle`].position[1] - frame.joints[`${support}_ankle`].position[1]).toBeGreaterThan(0.34);
    }
  }
});

test("recorded Apply phases precede each support edit and completed frames match the exact command", async ({ page }) => {
  await page.goto("/tools/dance-renderer.html");
  await page.waitForFunction(() => !!(window as any).__sequence);
  const result = await page.evaluate(async (instructions) => {
    const renderer = (window as any).__sequence;
    const initialized = renderer.initialize(undefined, "left", "sequence");
    // Fixture pixels exercise recording selection; the live recording test
    // separately verifies actual trusted public keyboard/mouse events.
    const canvas = document.createElement("canvas");
    canvas.width = 1008;
    canvas.height = 124;
    const image = canvas.toDataURL("image/png");
    await renderer.loadInteraction({
      width: 1008, height: 124,
      commands: instructions.map((instruction, command) => ({
        instruction, output: "fixture",
        // The last command completed before a busy frame was painted.
        frames: ["editing", "typed", "pressed", "applying", "done"].filter((phase) => command !== 2 || phase !== "applying").map((phase) => ({
          phase, image, file: `fixture-${command}-${phase}.png`,
        })),
      })),
    });
    return {
      opening: renderer.inspect(0).interaction,
      changes: initialized.launch.edits.map((edit: any) => ({
        pressed: renderer.inspect(edit.start - 0.21).interaction,
        applying: renderer.inspect(edit.start - 0.08).interaction,
        completed: renderer.inspect(edit.start).interaction,
      })),
    };
  }, instructions);
  expect(result.opening).toEqual({ instruction: instructions[0], phase: "done", file: "fixture-0-done.png" });
  for (const [index, change] of result.changes.entries()) {
    const command = index + 1;
    for (const [name, expectedPhase] of [["pressed", "pressed"], ["applying", "applying"], ["completed", "done"]] as const) {
      const phase = command === 2 && expectedPhase === "applying" ? "pressed" : expectedPhase;
      expect(change[name]).toEqual({ instruction: instructions[command], phase, file: `fixture-${command}-${phase}.png` });
    }
  }
});
