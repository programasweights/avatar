import { expect, test } from "@playwright/test";

test.use({
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  },
});

test("still arms preserve continuous gait playback while counted runs finish", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**", () => {});
  const outputs: Record<string, string> = {
    "Run with your arms still": "action run 1\narms still",
    "Run twice with your arms still": "action run 2\narms still",
  };
  await page.route("**/api/direct", (route) => {
    const { instruction } = route.request().postDataJSON();
    expect(Object.hasOwn(outputs, instruction)).toBe(true);
    return route.fulfill({ json: { output: outputs[instruction] } });
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(
    () => !!(window as any).__motion && !!(window as any).__motionStudio,
  );
  const snapshot = () =>
    page.evaluate(() => (window as any).__motionStudio.snapshot());
  async function applyAndPlayFinalFrames(instruction: string) {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    await page
      .getByRole("button", { name: "Apply direction", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Apply direction", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const duration = await page.evaluate(() => {
      const motion = (window as any).__motion;
      const time = motion.timeline.duration - 0.15;
      (window as any).__motionStudio.seek(time);
      motion.seek(time);
      return motion.timeline.duration;
    });
    await page
      .getByRole("button", { name: "Play current motion", exact: true })
      .click();
    return duration;
  }

  const firstDuration = await applyAndPlayFinalFrames(
    "Run with your arms still",
  );
  await expect(
    page.getByRole("checkbox", { name: "Loop", exact: true }),
  ).toBeChecked();
  await expect
    .poll(async () => (await snapshot()).time)
    .toBeLessThan(firstDuration - 0.2);
  expect((await snapshot()).playing).toBe(true);

  const countedDuration = await applyAndPlayFinalFrames(
    "Run twice with your arms still",
  );
  await expect(
    page.getByRole("checkbox", { name: "Loop", exact: true }),
  ).not.toBeChecked();
  await expect.poll(async () => (await snapshot()).playing).toBe(false);
  expect((await snapshot()).time).toBe(countedDuration);
  expect(countedDuration).toBeGreaterThan(firstDuration);
  expect(errors).toEqual([]);
});
