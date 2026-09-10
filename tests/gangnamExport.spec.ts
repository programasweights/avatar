import { expect, test } from "@playwright/test";
import { createDance } from "../src/motion/skills";

test("recording follows the replacement canvas when the character changes", async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any;
    host.__recordedCanvases = [];
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      if (this.canvas.width === 1080 && this.canvas.height === 1080 && args[0] instanceof HTMLCanvasElement)
        host.__recordedCanvases.push(args[0]);
      return (original as any).apply(this, args);
    };
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  await page.getByRole("button", { name: "Record current motion", exact: true }).click();
  await page.waitForFunction(() => (window as any).__recordedCanvases.includes(document.querySelector(".motion-stage canvas")));
  await page.getByText("Edit motion", { exact: true }).click();
  await page.getByLabel("Character", { exact: true }).selectOption("gangnam");
  await expect(page.getByText("Loading the character…")).toBeHidden();
  await page.waitForFunction(() => {
    const host = window as any;
    return host.__motionStudio.snapshot().character === "gangnam" &&
      host.__recordedCanvases.includes(document.querySelector(".motion-stage canvas"));
  });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await download;
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a custom full-body export uses the imported title rather than preset dance captions", async ({ page }) => {
  await page.goto("/tools/dance-renderer.html");
  await page.waitForFunction(() => !!(window as any).__sequence);
  const program = { ...createDance("idle"), title: "My quiet standing study" };
  const result = await page.evaluate((program) =>
    (window as any).__sequence.initialize({ program }), program);
  expect(result.cues).toEqual([
    { start: 0, duration: result.duration, instruction: "My quiet standing study" },
  ]);
});

test("a reference export keeps its camera fixed while the measured motion plays", async ({ page }) => {
  await page.goto("/tools/dance-renderer.html");
  await page.waitForFunction(() => !!(window as any).__sequence);
  const frames = await page.evaluate(() => {
    const renderer = (window as any).__sequence;
    renderer.initialize(undefined, "left", "classic", { fixedCamera: true });
    return [renderer.inspect(0), renderer.inspect(0.35), renderer.inspect(1.2)];
  });
  expect(frames[1].camera).toEqual(frames[0].camera);
  expect(frames[2].camera).toEqual(frames[0].camera);
  expect(frames[1].joints).not.toEqual(frames[0].joints);
});

test("a calibrated reference camera stays aligned across frames and resets for normal exports", async ({ page }) => {
  await page.goto("/tools/dance-renderer.html");
  await page.waitForFunction(() => !!(window as any).__sequence);
  const result = await page.evaluate((program) => {
    const renderer = (window as any).__sequence;
    renderer.initialize({ program, camera: { height: 2.15, position: [0, 1.03, 6], target: [0, 1.03, 0] } }, "left", "classic", { clean: true });
    const first = renderer.inspect(0).camera;
    const last = renderer.inspect(1).camera;
    renderer.initialize();
    return { first, last, normal: renderer.inspect(0).camera };
  }, createDance("idle"));
  expect(result.first.position).toEqual([0, 1.03, 6]);
  expect(result.last).toEqual(result.first);
  expect(result.normal).not.toEqual(result.first);
});
