import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const WIDTH = 1008;
const HEIGHT = 124;
const CLIP = { x: 36, y: 80, width: WIDTH, height: HEIGHT };
const DIRECTIONS = [
  { instruction: "Dance Gangnam Style.", support: "both" },
  { instruction: "Now on one foot.", support: "left" },
  { instruction: "Switch to the opposite foot.", support: "right" },
];

function branch(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = branch(child, id);
    if (found) return found;
  }
}

/** Record real deployed form interactions. CSS affects framing only. */
export async function recordGangnamInputs({ page, outDir, sourceUrl = "https://programasweights.com/gangnam", inspectOnly = false }) {
  const output = path.resolve(outDir);
  await fs.mkdir(output, { recursive: true });
  const url = new URL(sourceUrl);
  assert.equal(url.origin, "https://programasweights.com", "Use the deployed remote inference demo");
  url.pathname = url.pathname.replace(/\/$/, "");
  assert.ok(["/avatar", "/avatar/gangnam", "/gangnam"].includes(url.pathname), "Use the public avatar page");
  if (url.pathname === "/avatar") url.searchParams.set("example", "gangnam");
  const publicUrl = new URL(url);
  publicUrl.searchParams.delete("dbg");
  publicUrl.searchParams.delete("quality");
  url.searchParams.set("dbg", "1");
  url.searchParams.set("quality", "low");
  const manifest = {
    version: 1, width: WIDTH, height: HEIGHT, sourceUrl: url.href,
    recordedAt: new Date().toISOString(),
    method: "Real deployed form DOM screenshots, actual keyboard and mouse events. Recording-only CSS changes framing. Cursor follows real browser mouse events. No mocked responses, injected motion, or synthetic button animation.",
    frameTiming: "Each PNG was sampled during its captureStartedAtMs/captureFinishedAtMs interval. Editorial retiming belongs to the compositor; these timings are unmodified.",
    programs: {}, commands: [], requests: [], events: [], errors: [],
  };
  const isDirect = (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/avatar/direct";
  page.on("pageerror", (error) => manifest.errors.push(error.message));
  page.on("request", (request) => {
    if (isDirect(request)) manifest.requests.push({ instruction: request.postDataJSON().instruction, requestedAt: new Date().toISOString() });
  });
  const save = () => fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const now = () => page.evaluate(() => performance.now() - window.__pawInputCapture.start);
  const snapshot = () => page.evaluate(() => window.__motionStudio.snapshot());

  try {
    await page.goto(publicUrl.href, { waitUntil: "domcontentloaded" });
    await page.locator(".motion-stage canvas").waitFor({ state: "visible", timeout: 90_000 });
    await page.getByText("Loading the character…", { exact: true }).waitFor({ state: "hidden", timeout: 90_000 });
    await page.getByText("Example · Gangnam Style", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Pause current motion", exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    manifest.freshPublicPage = { url: page.url(), origin: "Example · Gangnam Style", playing: true };
    await page.screenshot({ path: path.join(output, "fresh-gangnam-demo.png") });
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.__motionStudio && !!window.__motion, undefined, { timeout: 90_000 });
    manifest.loadedState = await snapshot();
    assert.equal(manifest.loadedState.character, "gangnam");
    assert.equal(manifest.loadedState.program.dance?.style, "gangnam");
    assert.equal(manifest.loadedState.playing, true);
    await page.getByRole("button", { name: "Start over", exact: true }).click();
    manifest.initialState = await snapshot();
    await page.screenshot({ path: path.join(output, "original-public-ui.png") });
    await page.addStyleTag({ content: `
      html, body { overflow: hidden !important; }
      body * { visibility: hidden !important; }
      .motion-prompt, .motion-prompt *, #paw-capture-cursor, #paw-capture-cursor * { visibility: visible !important; }
      .motion-prompt { position: fixed !important; left: ${CLIP.x}px !important; top: ${CLIP.y}px !important; width: ${WIDTH}px !important; height: ${HEIGHT}px !important; margin: 0 !important; padding: 0 !important; display: block !important; z-index: 2147483000 !important; }
      .motion-prompt .motion-session { display: none !important; }
      .motion-prompt textarea { position: absolute !important; inset: 0 !important; box-sizing: border-box !important; width: 100% !important; height: 100% !important; min-height: 0 !important; margin: 0 !important; padding: 32px 260px 30px 25px !important; font-size: 43px !important; line-height: 60px !important; white-space: nowrap !important; overflow: hidden !important; border-radius: 18px !important; resize: none !important; }
      .motion-prompt .motion-primary { position: absolute !important; right: 18px !important; top: 30px !important; bottom: auto !important; width: 220px !important; height: 64px !important; min-height: 0 !important; padding: 10px 14px !important; margin: 0 !important; font-size: 22px !important; line-height: 1 !important; border-radius: 12px !important; }
      .motion-prompt .motion-primary svg { width: 20px !important; height: 20px !important; flex-shrink: 0 !important; }
      .motion-prompt .motion-primary:active:not(:disabled) { filter: brightness(.85); transform: translateY(1px); }
      #paw-capture-cursor { position: fixed; pointer-events: none; z-index: 2147483647; width: 28px; height: 36px; left: -100px; top: -100px; filter: drop-shadow(0 2px 2px #0009); }
      #paw-capture-cursor circle { opacity: 0; }
      #paw-capture-cursor[data-down="true"] circle { opacity: 1; }
    ` });
    await page.evaluate(() => {
      const cursor = document.createElement("div");
      cursor.id = "paw-capture-cursor";
      cursor.innerHTML = '<svg width="28" height="36" viewBox="0 0 28 36"><circle cx="8" cy="10" r="9" fill="#c4b5fd" fill-opacity=".75"/><path d="M3 2L3 26L9 20L15 32L20 29L14 18L23 17Z" fill="white" stroke="#171720" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.body.append(cursor);
      const capture = { start: performance.now(), events: [] };
      window.__pawInputCapture = capture;
      for (const type of ["mousemove", "mousedown", "mouseup", "input"]) {
        document.addEventListener(type, (event) => {
          if (type !== "input") {
            cursor.style.left = `${event.clientX}px`;
            cursor.style.top = `${event.clientY}px`;
            if (type === "mousedown") cursor.dataset.down = "true";
            if (type === "mouseup") cursor.dataset.down = "false";
          }
          capture.events.push({ type, atMs: performance.now() - capture.start, x: event.clientX, y: event.clientY, button: event.button, value: event.target instanceof HTMLTextAreaElement ? event.target.value : undefined, trusted: event.isTrusted });
        }, true);
      }
    });
    const input = page.getByLabel("Direction", { exact: true });
    const button = page.locator(".motion-prompt .motion-primary");
    const box = await page.locator(".motion-prompt").boundingBox();
    assert.deepEqual(box, CLIP);
    // Park the pointer in the unused right side of the input. The browser's
    // own caret remains at the text end; the pointer must not cover letters.
    const inputPoint = { x: CLIP.x + 690, y: CLIP.y + 63 };
    const initialButton = await button.boundingBox();
    let pointer = { x: initialButton.x + initialButton.width / 2, y: initialButton.y + initialButton.height / 2 };
    await page.mouse.move(pointer.x, pointer.y);
    const frame = async (entry, phase, include = true) => {
      const directory = `command-${String(manifest.commands.length).padStart(2, "0")}`;
      await fs.mkdir(path.join(output, directory), { recursive: true });
      const number = (entry.nextFrame ?? 0);
      entry.nextFrame = number + 1;
      const file = `${directory}/frame-${String(number).padStart(3, "0")}-${phase}.png`;
      const captureStartedAtMs = await now();
      const buttonTextBefore = (await button.innerText()).trim();
      await page.screenshot({ path: path.join(output, file), clip: CLIP, caret: "initial", animations: "allow", scale: "css" });
      const inputState = await input.evaluate((element) => ({
        selectionStart: element.selectionStart, selectionEnd: element.selectionEnd,
        scrollLeft: element.scrollLeft, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      }));
      const item = { file, phase, capturedAtMs: captureStartedAtMs, captureStartedAtMs, captureFinishedAtMs: await now(), value: await input.inputValue(), inputState, pointer: { ...pointer }, buttonTextBefore, buttonText: (await button.innerText()).trim() };
      if (include) entry.frames.push(item);
      return item;
    };
    if (inspectOnly) {
      await page.screenshot({ path: path.join(output, "form-preview.png"), clip: CLIP, caret: "initial" });
      await save();
      return manifest;
    }

    for (const direction of DIRECTIONS) {
      const entry = { instruction: direction.instruction, frames: [] };
      manifest.commands.push(entry);
      entry.previousState = await snapshot();
      entry.before = await frame(entry, "idle", false);
      const from = { ...pointer };
      for (let step = 1; step <= 6; step++) {
        const fraction = step / 6;
        pointer = { x: from.x + (inputPoint.x - from.x) * fraction, y: from.y + (inputPoint.y - from.y) * fraction };
        await page.mouse.move(pointer.x, pointer.y);
        await frame(entry, "focusing");
      }
      await page.mouse.down();
      await page.mouse.up();
      await page.keyboard.press("ControlOrMeta+A");
      await frame(entry, "selected");
      await page.keyboard.press("Backspace");
      await frame(entry, "editing");
      for (const character of direction.instruction) {
        await page.keyboard.type(character);
        await frame(entry, "editing");
      }
      assert.equal(await input.evaluate((element) => element.scrollLeft), 0, "The whole instruction must fit without horizontal scrolling.");
      await frame(entry, "typed");
      const buttonBox = await button.boundingBox();
      for (let step = 1; step <= 6; step++) {
        const fraction = step / 6;
        pointer = {
          x: inputPoint.x + (buttonBox.x + buttonBox.width / 2 - inputPoint.x) * fraction,
          y: inputPoint.y + (buttonBox.y + buttonBox.height / 2 - inputPoint.y) * fraction,
        };
        await page.mouse.move(pointer.x, pointer.y);
        await frame(entry, "moving");
      }
      const responsePromise = page.waitForResponse((response) => isDirect(response.request()) && response.request().postDataJSON().instruction === direction.instruction, { timeout: 180_000 });
      await page.mouse.down();
      await frame(entry, "pressed");
      entry.submittedAtMs = await now();
      const requestStart = performance.now();
      await page.mouse.up();
      const applying = await frame(entry, "applying", false);
      entry.applyingVisible = applying.buttonTextBefore === "Applying…" && applying.buttonText === "Applying…";
      if (entry.applyingVisible) entry.frames.push(applying);
      else entry.uncertainTransition = { ...applying, phase: "transition", reason: "The request completed during or before this screenshot. Do not use it as evidence of a visible Applying state." };
      const response = await responsePromise;
      entry.status = response.status();
      entry.response = await response.json();
      await response.finished();
      entry.observedAfterCaptureMs = performance.now() - requestStart;
      entry.requestTiming = response.request().timing();
      entry.elapsedMs = entry.requestTiming.responseEnd;
      entry.responseObservedAtMs = await now();
      entry.output = entry.response.output;
      assert.equal(entry.status, 200, JSON.stringify(entry.response));
      await page.waitForFunction(() => !document.querySelector(".motion-prompt .motion-primary").disabled, undefined, { timeout: 90_000 });
      await page.waitForFunction((support) => window.__motionStudio.snapshot().program.dance?.support === support, direction.support, { timeout: 30_000 });
      assert.equal(await page.getByRole("alert").count(), 0);
      entry.resultState = await snapshot();
      assert.equal(entry.resultState.caption, direction.instruction);
      assert.equal(entry.resultState.character, "gangnam");
      assert.equal(entry.resultState.program.dance.style, "gangnam");
      assert.equal(entry.resultState.program.bpm, 132);
      assert.equal(entry.resultState.playing, true);
      if (direction.support !== "both") {
        const initial = manifest.programs.both;
        for (const id of ["arms", "details", "torso.groove"]) {
          assert.ok(branch(initial.root, id));
          assert.deepEqual(branch(entry.resultState.program.root, id), branch(initial.root, id), `${id} must survive the support edit`);
        }
      }
      manifest.programs[direction.support] = entry.resultState.program;
      entry.programFile = `program-${direction.support}.json`;
      await fs.writeFile(path.join(output, entry.programFile), JSON.stringify(entry.resultState.program, null, 2) + "\n");
      await frame(entry, "done");
      entry.confirmedAtMs = await now();
      await save();
    }
    assert.deepEqual(manifest.requests.map((request) => request.instruction), DIRECTIONS.map((direction) => direction.instruction));
    assert.deepEqual(manifest.errors, []);
    manifest.events = await page.evaluate(() => window.__pawInputCapture.events);
    manifest.complete = true;
    await save();
    return manifest;
  } catch (error) {
    manifest.failure = error.stack ?? String(error);
    manifest.events = await page.evaluate(() => window.__pawInputCapture?.events ?? []).catch(() => []);
    await save();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const outDir = value("--out", path.resolve("exports/gangnam-inputs"));
  const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1 });
    const result = await recordGangnamInputs({ page, outDir, sourceUrl: value("--url", "https://programasweights.com/gangnam"), inspectOnly: args.includes("--inspect") });
    console.log(JSON.stringify({ manifest: path.join(path.resolve(outDir), "manifest.json"), complete: result.complete ?? false, commands: result.commands.map(({ instruction, output, elapsedMs }) => ({ instruction, output, elapsedMs })) }, null, 2));
  } finally {
    await browser.close();
  }
}
