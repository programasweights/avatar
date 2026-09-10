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
  expect(result.commands.map(({ instruction }) => instruction)).toEqual([
    "Dance Gangnam Style.",
    "Now on one foot.",
    "Switch to the opposite foot.",
  ]);
  expect(result.commands.map(({ resultState }) => resultState.program.dance.support)).toEqual(["both", "left", "right"]);
  for (const command of result.commands) {
    expect(command.frames.some((frame) => frame.phase === "pressed")).toBe(true);
    expect(command.frames.some((frame) => frame.phase === "applying" && frame.buttonText === "Applying…")).toBe(command.applyingVisible);
    expect(command.frames.at(-1)?.phase).toBe("done");
    expect(command.response.trace.dance_confirmation).toBe("yes");
  }
  expect(result.events.filter((event) => event.type === "input").every((event) => event.trusted)).toBe(true);
  await testInfo.attach("real-input-capture", { path: `${outDir}/manifest.json`, contentType: "application/json" });
});
