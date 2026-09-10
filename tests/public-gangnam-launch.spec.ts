import { expect, test } from "@playwright/test";
import { recordGangnamInputs } from "../tools/record-gangnam-inputs.mjs";

// This is also the launch interaction recording. It sends exactly three real,
// sequential requests to the deployed PAW endpoint, without route mocks.
test.skip(process.env.AVATAR_LIVE_PUBLIC !== "1", "Opt in to real public launch commands.");
test.use({
  viewport: { width: 1280, height: 960 },
  launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] },
});

test("exact launch phrases preserve the dance and switch the supporting foot", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const outDir = process.env.AVATAR_RECORDING_DIR || testInfo.outputPath("interaction");
  const result = await recordGangnamInputs({ page, outDir });
  expect(result.complete).toBe(true);
  expect(result.freshPublicPage.url).toBe("https://programasweights.com/avatar/gangnam");
  expect(result.freshPublicPage.origin).toBe("Example · Gangnam Style");
  expect(result.freshPublicPage.playing).toBe(true);
  expect(new URL(result.sourceUrl).pathname).toBe("/avatar/gangnam");
  expect(new URL(result.sourceUrl).searchParams.has("example")).toBe(false);
  expect(result.loadedState.character).toBe("gangnam");
  expect(result.loadedState.program.dance.style).toBe("gangnam");
  expect(result.loadedState.playing).toBe(true);
  expect(result.commands.map(({ instruction }) => instruction)).toEqual([
    "Dance Gangnam Style.",
    "Now on one foot.",
    "Switch to the opposite foot.",
  ]);
  expect(result.commands.map(({ resultState }) => resultState.program.dance.support)).toEqual(["both", "left", "right"]);
  const textRightEdges = await page.getByLabel("Direction", { exact: true }).evaluate((input, values: string[]) => {
    const style = getComputedStyle(input);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const start = input.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    return Object.fromEntries(values.map((value) => [value, start + context.measureText(value).width]));
  }, result.commands.flatMap((command) => command.frames.map((frame) => frame.value)));
  for (const [index, command] of result.commands.entries()) {
    const focusing = command.frames.filter((frame) => frame.phase === "focusing");
    const selected = command.frames.find((frame) => frame.phase === "selected");
    const editingFrames = command.frames.filter((frame) => frame.phase === "editing");
    const editing = editingFrames[0];
    const typed = command.frames.find((frame) => frame.phase === "typed");
    const moving = command.frames.filter((frame) => frame.phase === "moving");
    const pressed = command.frames.find((frame) => frame.phase === "pressed");
    expect(selected).toBeDefined();
    if (index > 0) expect(selected?.value).toBe(result.commands[index - 1].instruction);
    expect(selected?.inputState.selectionStart).toBe(0);
    expect(selected?.inputState.selectionEnd).toBe(selected.value.length);
    expect(editing?.value).toBe("");
    expect(selected?.capturedAtMs).toBeLessThan(editing.capturedAtMs);
    expect(typed?.value).toBe(command.instruction);
    for (const frame of [...editingFrames, typed]) {
      expect(frame.inputState.selectionStart).toBe(frame.value.length);
      expect(frame.inputState.selectionEnd).toBe(frame.value.length);
      expect(frame.inputState.scrollLeft).toBe(0);
    }
    for (const frame of [selected, ...editingFrames, typed]) {
      expect(frame.pointer).toEqual({ x: 726, y: 143 });
      expect(frame.pointer.x).toBeGreaterThan(textRightEdges[frame.value] + 8);
    }
    expect(focusing.length).toBeGreaterThan(1);
    let previousPointer = command.before.pointer;
    for (const frame of focusing) {
      expect(frame.pointer.x).toBeLessThan(previousPointer.x);
      expect(frame.pointer.x).toBeGreaterThanOrEqual(selected.pointer.x);
      expect(frame.value).toBe(selected.value);
      expect(frame.capturedAtMs).toBeGreaterThan(command.before.capturedAtMs);
      expect(frame.capturedAtMs).toBeLessThan(selected.capturedAtMs);
      previousPointer = frame.pointer;
    }
    expect(focusing.at(-1)?.pointer).toEqual(selected.pointer);
    expect(moving.length).toBeGreaterThan(1);
    expect(new Set(moving.map((frame) => frame.file)).size).toBe(moving.length);
    previousPointer = typed.pointer;
    for (const frame of moving) {
      expect(frame.value).toBe(command.instruction);
      expect(frame.capturedAtMs).toBeGreaterThan(typed.capturedAtMs);
      expect(frame.capturedAtMs).toBeLessThan(pressed.capturedAtMs);
      expect(frame.pointer.x).toBeGreaterThan(previousPointer.x);
      expect(frame.pointer.x).toBeLessThanOrEqual(pressed.pointer.x);
      previousPointer = frame.pointer;
    }
    expect(moving.at(-1)?.pointer).toEqual(pressed.pointer);
    expect(command.frames.at(-1)?.pointer).toEqual(pressed.pointer);
    expect(command.frames.some((frame) => frame.phase === "pressed")).toBe(true);
    expect(command.frames.some((frame) => frame.phase === "applying" && frame.buttonText === "Applying…")).toBe(command.applyingVisible);
    expect(command.frames.at(-1)?.phase).toBe("done");
    expect(command.response.trace.dance_confirmation).toBe("yes");
  }
  expect(result.events.filter((event) => event.type === "input").every((event) => event.trusted)).toBe(true);
  await testInfo.attach("real-input-capture", { path: `${outDir}/manifest.json`, contentType: "application/json" });
});
