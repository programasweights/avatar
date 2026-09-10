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

test("recorded inputs show cursor travel into the field, selection, and a reading pause before Apply", async ({ page }) => {
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
        // Command 2 represents an older recording: optional selection, cursor
        // travel, and the busy frame were not captured.
        frames: ["focusing", "selected", "editing", "typed", "moving", "pressed", "applying", "done"]
          .filter((phase) => command !== 2 || !["focusing", "selected", "moving", "applying"].includes(phase))
          .flatMap((phase) => Array.from({ length: ["focusing", "moving"].includes(phase) ? 3 : 1 }, (_, index) => ({
            phase, image, file: `fixture-${command}-${phase}-${index}.png`,
          }))),
      })),
    });
    return {
      opening: renderer.inspect(0).interaction,
      changes: initialized.launch.edits.map((edit: any) => ({
        before: renderer.inspect(edit.start - 1.351),
        focusing: [1.335, 1.275, 1.215].map((offset) => renderer.inspect(edit.start - offset)),
        beforeSelection: renderer.inspect(edit.start - 1.201),
        selectionStart: renderer.inspect(edit.start - 1.199),
        selected: renderer.inspect(edit.start - 1.125),
        editing: renderer.inspect(edit.start - 0.85),
        readingStart: renderer.inspect(edit.start - 0.64),
        readingEnd: renderer.inspect(edit.start - 0.46),
        moving: [0.435, 0.375, 0.315].map((offset) => renderer.inspect(edit.start - offset)),
        pressed: renderer.inspect(edit.start - 0.235),
        applying: renderer.inspect(edit.start - 0.08),
        beforeResult: renderer.inspect(edit.start - 0.001),
        completed: renderer.inspect(edit.start),
      })),
    };
  }, instructions);
  const captured = (command: number, phase: string, index = 0) => ({
    instruction: instructions[command], phase, file: `fixture-${command}-${phase}-${index}.png`,
  });
  expect(result.opening).toEqual(captured(0, "done"));
  for (const [index, change] of result.changes.entries()) {
    const command = index + 1;
    expect(change.before.interaction).toEqual(captured(command - 1, "done"));
    expect(change.focusing.map((frame: any) => frame.interaction)).toEqual(
      command === 2 ? Array.from({ length: 3 }, () => captured(command - 1, "done"))
        : [0, 1, 2].map((frame) => captured(command, "focusing", frame)),
    );
    expect(change.beforeSelection.interaction).toEqual(change.focusing.at(-1)?.interaction);
    expect(change.selected.interaction).toEqual(captured(command, command === 2 ? "editing" : "selected"));
    expect(change.selectionStart.interaction).toEqual(change.selected.interaction);
    expect(change.editing.interaction).toEqual(captured(command, "editing"));
    expect(change.readingStart.interaction).toEqual(captured(command, "typed"));
    expect(change.readingEnd.interaction).toEqual(change.readingStart.interaction);
    expect(change.moving.map((frame: any) => frame.interaction)).toEqual(
      command === 2 ? Array.from({ length: 3 }, () => captured(command, "typed"))
        : [0, 1, 2].map((frame) => captured(command, "moving", frame)),
    );
    expect(change.pressed.interaction).toEqual(captured(command, "pressed"));
    expect(change.applying.interaction).toEqual(captured(command, command === 2 ? "pressed" : "applying"));
    expect(change.beforeResult.interaction).toEqual(change.applying.interaction);
    // Reading and Apply must never show the command's resulting motion early.
    for (const frame of [...change.focusing, change.beforeSelection, change.selectionStart,
      change.selected, change.editing, change.readingStart, change.readingEnd,
      ...change.moving, change.pressed, change.applying, change.beforeResult])
      expect(frame.cue).toBe(instructions[command - 1]);
    expect(change.completed.interaction).toEqual(captured(command, "done"));
    expect(change.completed.cue).toBe(instructions[command]);
  }
});
