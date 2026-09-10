// Offline geometry fitting only. Landmark extraction is a separate explicit step.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
if (!args.includes("--input")) {
  console.log("node tools/retarget-reference.mjs --input landmarks.json --output /tmp/reference-motion.json [--prepare-only] [--max-frames 240] [--ground-pixel-y 720]");
  process.exit(args.includes("--help") ? 0 : 1);
}
let input = JSON.parse(await readFile(resolve(value("--input")), "utf8"));
if (Array.isArray(input)) input = { manualFrames: input, width: Number(value("--width", 640)), height: Number(value("--height", 360)), fps: Number(value("--fps", 25)) };
if (args.includes("--stabilization")) input.cameraStabilization = JSON.parse(await readFile(resolve(value("--stabilization")), "utf8"));
if (args.includes("--orientation")) input.orientation = JSON.parse(await readFile(resolve(value("--orientation")), "utf8"));
const output = resolve(value("--output", "/tmp/avatar-reference-motion.json"));
const options = { maxFrames: Number(value("--max-frames", 240)), bpm: Number(value("--bpm", 132)), smoothRadius: Number(value("--smooth-radius", 1)) };
if (args.includes("--ground-pixel-y")) options.groundPixelY = Number(value("--ground-pixel-y"));
if (args.includes("--floor-threshold")) options.floorThreshold = Number(value("--floor-threshold"));
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  page.on("pageerror", error => console.error(error.message));
  await page.exposeFunction("__fitProgress", progress => console.log(`Fit ${progress.frame}/${progress.total}`));
  await page.goto(new URL("tools/reference-fit.html", server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => !!window.__referenceFit);
  const result = await page.evaluate(async ({ input, options, prepare }) => prepare
    ? window.__referenceFit.prepareReference(input, options)
    : await window.__referenceFit.fit(input, options), { input, options, prepare: args.includes("--prepare-only") });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result.program ?? result, null, 2) + "\n");
  if (result.report) await writeFile(output.replace(/\.json$/, "") + ".report.json", JSON.stringify(result.report, null, 2) + "\n");
  console.log(`Wrote ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
