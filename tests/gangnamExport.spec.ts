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
