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
    "npm run render -- [--input motion.json] [--output exports/showcase.mp4] [--side left|right] [--preview]",
  );
  process.exit(0);
}
const side = value("--side", "left");
if (!["left", "right"].includes(side))
  throw new Error("Choose --side left or right.");
const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(value("--output", "exports/showcase.mp4"));
const preview = args.includes("--preview");
const ffmpeg = process.env.FFMPEG || "ffmpeg";
if (
  !preview &&
  spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0
) {
  throw new Error("Install ffmpeg, or set FFMPEG to its executable path.");
}
let input;
if (args.includes("--input")) {
  const data = JSON.parse(await readFile(resolve(value("--input")), "utf8"));
  input = data.program ? data : { program: data };
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
    new URL("tools/renderer.html", server.resolvedUrls.local[0]).href,
  );
  await page.waitForFunction(() => !!window.__sequence);
  const result = await page.evaluate(
    ({ input, side }) => window.__sequence.initialize(input, side),
    { input, side },
  );
  await writeFile(
    output.replace(/\.[^.]+$/, "") + ".json",
    JSON.stringify(result.program, null, 2) + "\n",
  );
  if (preview) {
    const observations = [];
    for (const fraction of [
      0, 0.1, 0.22, 0.35, 0.45, 0.54, 0.6, 0.64, 0.7, 0.8, 0.95,
    ]) {
      const time = result.duration * fraction;
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
    const fps = 24,
      frames = Math.ceil(result.duration * fps);
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
        "-an",
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
    console.log(`Saved ${output} (${frames} frames, 24 fps, 1080 × 1080)`);
  }
} finally {
  encoder?.kill("SIGTERM");
  await browser?.close();
  await server.close();
}
