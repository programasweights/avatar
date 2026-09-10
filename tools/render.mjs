// Render the actual motion tree at exact frame times, independently of GPU speed.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const args = process.argv.slice(2);
const value = (flag, fallback) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
if (args.includes("--help")) {
  console.log(
    "npm run render -- [--input motion.json] [--output exports/showcase.mp4] [--side left|right] [--preview] [--dance --variation classic|one-foot|sequence] [--interaction recorded-inputs/manifest.json] [--audio beat.wav] [--duration seconds] [--fps 24] [--fixed-camera] [--camera camera.json] [--clean]",
  );
  process.exit(0);
}
const side = value("--side", "left");
const dance = args.includes("--dance");
const variation = value("--variation", "classic");
const durationLimit = args.includes("--duration") ? Number(value("--duration")) : undefined;
const fps = Number(value("--fps", "24"));
if (!Number.isInteger(fps) || fps < 15 || fps > 60)
  throw new Error("Choose an integer --fps between 15 and 60.");
if (durationLimit !== undefined && (!Number.isFinite(durationLimit) || durationLimit <= 0))
  throw new Error("Choose a positive --duration in seconds.");
if (!["classic", "one-foot", "sequence"].includes(variation))
  throw new Error("Choose --variation classic, one-foot, or sequence.");
if (!["left", "right"].includes(side))
  throw new Error("Choose --side left or right.");
const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(value("--output", "exports/showcase.mp4"));
const preview = args.includes("--preview");
const audioFile = args.includes("--audio") ? resolve(value("--audio")) : undefined;
const ffmpeg = process.env.FFMPEG || "ffmpeg";
if (
  !preview &&
  spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0
) {
  throw new Error("Install ffmpeg, or set FFMPEG to its executable path.");
}
let input;
let recording;
if (args.includes("--input")) {
  const data = JSON.parse(await readFile(resolve(value("--input")), "utf8"));
  input = data.program ? data : { program: data };
}
if (args.includes("--interaction")) {
  if (!dance || variation !== "sequence" || input)
    throw new Error("--interaction requires --dance --variation sequence and replaces --input with the captured public programs.");
  const path = resolve(value("--interaction"));
  recording = JSON.parse(await readFile(path, "utf8"));
  input = { launchPrograms: recording.programs };
  const recordedUrl = new URL(recording.sourceUrl);
  if (!recording.complete || recordedUrl.origin !== "https://programasweights.com" || !["/avatar", "/avatar/gangnam", "/gangnam"].includes(recordedUrl.pathname))
    throw new Error("Expected genuine input captured from the public avatar interface.");
  if (["both", "left", "right"].some((support) => !recording.programs?.[support]?.root))
    throw new Error("The interaction recording must include all three returned motion programs.");
  recording.commands = await Promise.all(recording.commands.map(async (command) => ({
    ...command,
    frames: await Promise.all(command.frames.map(async (frame) => ({
      ...frame,
      image: `data:image/png;base64,${(await readFile(resolve(dirname(path), frame.file))).toString("base64")}`,
    }))),
  })));
}
if (dance && variation === "sequence" && !input?.program && !recording && !preview && !args.includes("--clean"))
  throw new Error("The launch export needs --interaction from tools/record-gangnam-inputs.mjs; use --preview or --clean for choreography-only checks.");
if (args.includes("--camera")) {
  if (!dance || !input) throw new Error("--camera requires --dance and --input.");
  input.camera = JSON.parse(await readFile(resolve(value("--camera")), "utf8"));
}
await mkdir(dirname(output), { recursive: true });
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  logLevel: "error",
});
let browser, encoder;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1080 },
  });
  page.setDefaultTimeout(120000);
  await page.routeWebSocket("**", () => {});
  page.on("pageerror", (error) => console.error(error.message));
  await page.goto(
    new URL(dance ? "tools/dance-renderer.html" : "tools/renderer.html", server.resolvedUrls.local[0]).href,
  );
  await page.waitForFunction(() => !!window.__sequence);
  if (recording) await page.evaluate((recording) => window.__sequence.loadInteraction(recording), recording);
  const result = await page.evaluate(
    ({ input, side, variation, fixedCamera, clean }) => window.__sequence.initialize(input, side, variation, { fixedCamera, clean }),
    { input, side, variation, fixedCamera: args.includes("--fixed-camera"), clean: args.includes("--clean") },
  );
  await writeFile(
    output.replace(/\.[^.]+$/, "") + ".json",
    JSON.stringify(result.program, null, 2) + "\n",
  );
  const renderDuration = Math.min(result.duration, durationLimit ?? Infinity);
  const frameCount = Math.ceil(renderDuration * fps - 1e-9);
  if (dance) await writeFile(output.replace(/\.[^.]+$/, "") + ".timeline.json", JSON.stringify({
    ...result, program: undefined,
    export: { fps, frames: frameCount, duration: frameCount / fps },
    edited: !!recording,
    sourceUrl: recording?.sourceUrl,
    sourceCommands: recording?.commands.map(({ instruction, output, elapsedMs }) => ({ instruction, output, elapsedMs })),
    editing: result.launch ? { applyToResultSeconds: .30, inferenceWaitSeconds: .17, cursorReturnSeconds: .15, selectionSeconds: .15, typingSeconds: .40, readingSeconds: .20, cursorTravelSeconds: .15,
      pressedAt: result.launch.edits.map((edit) => edit.start - .30),
      submittedAt: result.launch.edits.map((edit) => edit.start - .17),
      results: result.launch.edits.map((edit) => edit.start),
      settled: result.launch.edits.map((edit) => edit.settled) } : undefined,
    audio: audioFile,
  }, null, 2) + "\n");
  if (preview) {
    const observations = [];
    for (const fraction of [
      0, 0.1, 0.22, 0.35, 0.45, 0.54, 0.6, 0.64, 0.7, 0.8, 0.95,
    ]) {
      const time = renderDuration * fraction;
      const data = await page.evaluate(
        (time) => window.__sequence.render(time, "png"),
        time,
      );
      await writeFile(
        resolve(dirname(output), `${side}_${time.toFixed(3)}.png`),
        Buffer.from(data, "base64"),
      );
      observations.push({
        time,
        ...(await page.evaluate(
          (time) => window.__sequence.inspect(time),
          time,
        )),
      });
    }
    await writeFile(
      resolve(dirname(output), `observations_${side}.json`),
      JSON.stringify(observations, null, 2),
    );
    console.log(`Preview frames saved in ${dirname(output)}`);
  } else {
    const frames = frameCount;
    const encodedDuration = frames / fps;
    encoder = spawn(
      ffmpeg,
      [
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-framerate",
        String(fps),
        "-i",
        "pipe:0",
        ...(audioFile ? ["-i", audioFile, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "160k", "-af", `apad,atrim=duration=${encodedDuration},afade=t=out:st=${Math.max(0, encodedDuration - .05)}:d=0.05`] : ["-an"]),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    encoder.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    encoder.stdin.on("error", () => {});
    const done = once(encoder, "close");
    for (let first = 0; first < frames; first += 8) {
      const data = await page.evaluate(
        ({ first, count, fps }) =>
          Array.from({ length: count }, (_, index) =>
            window.__sequence.render((first + index) / fps),
          ),
        { first, count: Math.min(8, frames - first), fps },
      );
      for (const encoded of data) {
        if (encoder.exitCode !== null || encoder.stdin.destroyed)
          throw new Error(stderr || "Video encoder stopped.");
        if (!encoder.stdin.write(Buffer.from(encoded, "base64")))
          await once(encoder.stdin, "drain");
      }
      if (first % 48 === 0) console.log(`${first}/${frames} frames`);
    }
    encoder.stdin.end();
    const [code] = await done;
    if (code !== 0) throw new Error(stderr);
    encoder = undefined;
    console.log(`Saved ${output} (${frames} frames, ${fps} fps, 1080 × 1080)`);
  }
} finally {
  encoder?.kill("SIGTERM");
  await browser?.close();
  await server.close();
}
