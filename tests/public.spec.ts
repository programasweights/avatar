import { expect, test } from "@playwright/test";
import { compileMotion } from "../src/motion/engine";
import { currentMotionHand } from "../src/motion/relative";

// Explicit opt-in: these are real requests to the published PAW director.
// AVATAR_LIVE_PUBLIC=1 npx playwright test tests/public.spec.ts
test.use({
  viewport: { width: 1280, height: 840 },
  video: "on",
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  },
});

test("public language directions preserve the visible creation through hand, speed and joint edits", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.AVATAR_LIVE_PUBLIC !== "1",
    "Opt in to real public inference",
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  const responses: {
    instruction: string;
    result: unknown;
    milliseconds: number;
  }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("https://programasweights.com/avatar?dbg=1&quality=low");
  await page.waitForFunction(
    () => !!(window as any).__motionStudio && !!(window as any).__motion,
  );
  await expect(
    page.getByRole("link", { name: "Source code", exact: true }),
  ).toHaveAttribute("href", "https://github.com/programasweights/avatar");
  const snapshot = () =>
    page.evaluate(() => (window as any).__motionStudio.snapshot());
  async function direct(instruction: string, expected: string) {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    const started = Date.now();
    const request = page.waitForResponse((r) =>
      r.url().endsWith("/api/v1/avatar/direct"),
    );
    await page
      .getByRole("button", { name: "Apply direction", exact: true })
      .click();
    const response = await request;
    const result = await response.json();
    responses.push({ instruction, result, milliseconds: Date.now() - started });
    expect(response.status()).toBe(200);
    expect(result.output).toBe(expected);
    await expect(
      page.getByRole("button", { name: "Apply direction", exact: true }),
    ).toBeEnabled();
    if (expected !== "unsupported")
      await expect(page.getByRole("alert")).toHaveCount(0);
    await page.waitForTimeout(500); // Show the executed motion in the walkthrough.
  }

  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await direct("Roll a coin", "skill coin_roll left forward");
  const coin = await snapshot();
  expect(coin.focus).toBe("left_hand");
  await direct("Use the other hand", "hand other");
  const right = await snapshot();
  expect(currentMotionHand(right.program)).toBe("right");
  expect(right.focus).toBe("right_hand");
  await direct("Reverse it", "reverse current");
  const reversed = await snapshot();
  await direct("Make it twice as fast", "tempo_scale 2");
  const faster = await snapshot();
  expect(faster.program.bpm).toBe(coin.program.bpm * 2);
  expect(compileMotion(faster.program).duration).toBeCloseTo(
    compileMotion(reversed.program).duration / 2,
    8,
  );
  expect(faster.focus).toBe("right_hand");
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  expect((await snapshot()).program).toEqual(faster.program);
  await direct("Roll a coin on your head", "unsupported");
  await expect(page.getByRole("alert")).toContainText("supported yet");
  expect((await snapshot()).program).toEqual(faster.program);
  await page.screenshot({
    path: testInfo.outputPath("unsupported_keeps_coin.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await direct(
    "Could you move just your left thumb?",
    "joint left_thumb_1 z 45",
  );
  expect((await snapshot()).selectedTargets).toEqual(["left_thumb_1"]);
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await direct("Dance salsa", "dance salsa");
  await direct("Lift your left leg 30 degrees", "joint left_hip x -30");
  const dancing = await snapshot();
  await direct(
    "Keep dancing salsa and wiggle your left index finger 35 degrees",
    "wiggle left_index_1 z 35",
  );
  const detailed = await snapshot();
  const feet = (program: any) =>
    compileMotion(program).tracks.filter((track) =>
      /_(hip|knee|ankle|foot_ik)$/.test(track.target),
    );
  expect(feet(detailed.program)).toEqual(feet(dancing.program));
  await direct("Wave hello with your left hand", "wave left");
  expect((await snapshot()).selectedTargets).toContain("left_wrist");
  expect((await snapshot()).focus).toBe("body");
  expect(errors).toEqual([]);
  await testInfo.attach("live-responses", {
    body: JSON.stringify(responses, null, 2),
    contentType: "application/json",
  });
});
