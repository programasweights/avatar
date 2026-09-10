import { expect, test } from "@playwright/test";

test("the Gangnam deep link opens the actual dancing character and survives its first asset request failing", async ({ page }) => {
  let downloads = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/assets/gangnam-character.glb", async (route) => {
    downloads++;
    if (downloads === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/?example=gangnam&dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  await expect(page.getByText("Loading the character…")).toBeHidden();
  await expect(page.getByText("Example · Gangnam Style", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Loop", { exact: true })).toBeChecked();
  const state = await page.evaluate(() => (window as any).__motionStudio.snapshot());
  expect(state.character).toBe("gangnam");
  expect(state.focus).toBe("body");
  expect(state.program.dance).toEqual({ style: "gangnam", support: "both" });
  expect(downloads).toBe(2);
  expect(errors).toEqual([]);
});

test("a direction selects the dance and costume; a foot edit and stop preserve the current program", async ({ page }) => {
  const responses: Record<string, string> = {
    "Dance Gangnam Style.": "dance gangnam",
    "Now on one foot.": "support left",
    "stop": "playback pause",
    "Both feet again.": "support both",
  };
  const requests: string[] = [];
  await page.route("**/api/direct", async (route) => {
    const { instruction } = route.request().postDataJSON();
    requests.push(instruction);
    await route.fulfill({ json: { output: responses[instruction], trace: { mocked: true } } });
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  async function direct(instruction: string) {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    await page.getByRole("button", { name: "Apply direction", exact: true }).click();
    await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  }
  await direct("Dance Gangnam Style.");
  await page.waitForFunction(() => (window as any).__motionStudio.snapshot().character === "gangnam" && !!(window as any).__motion);
  await expect(page.getByText("Loading the character…")).toBeHidden();
  await direct("Now on one foot.");
  const edited = await page.evaluate(() => (window as any).__motionStudio.snapshot());
  expect(edited.program.dance).toEqual({ style: "gangnam", support: "left" });
  expect(edited.focus).toBe("body");
  expect(edited.playing).toBe(true);
  await direct("stop");
  const stopped = await page.evaluate(() => (window as any).__motionStudio.snapshot());
  expect(stopped.program).toEqual(edited.program);
  expect(stopped.playing).toBe(false);
  await direct("Both feet again.");
  expect(await page.evaluate(() => (window as any).__motionStudio.snapshot().program.dance.support)).toBe("both");
  expect(requests).toEqual(Object.keys(responses));
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  const reset = await page.evaluate(() => (window as any).__motionStudio.snapshot());
  expect(reset.program.dance).toBeUndefined();
  expect(reset.playing).toBe(false);
});

test("the original hand demo remains available after loading Gangnam", async ({ page }) => {
  await page.goto("/?example=gangnam&dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  await page.getByText("More motions", { exact: true }).click();
  await page.getByRole("button", { name: "Load hand demo", exact: true }).click();
  const state = await page.evaluate(() => (window as any).__motionStudio.snapshot());
  expect(state.cues.filter((cue: any) => cue.instruction).map((cue: any) => cue.instruction)).toEqual([
    "Make a wave from pinky to thumb on your left hand.",
    "Reverse the finger ripple on your left hand.",
    "Touch your left thumb to each fingertip, index first.",
    "Roll a coin across your left knuckles.",
  ]);
  expect(state.focus).toBe("left_hand");
  expect(state.loop).toBe(false);
});
