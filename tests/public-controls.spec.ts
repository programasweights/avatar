import { expect, test } from "@playwright/test";
import { compileMotion } from "../src/motion/engine";
import type { MotionProgram } from "../src/motion/types";

// Real published PAW requests; run sequentially after deployment.
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/public-controls.spec.ts --workers=1
test.skip(
  process.env.AVATAR_LIVE_PUBLIC !== "1",
  "Opt in to real public inference.",
);
test.use({
  viewport: { width: 1280, height: 960 },
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

test("public directions preserve playback, still arms, and each hopping foot", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  const calls: {
    instruction: string;
    status: number;
    result: unknown;
    milliseconds: number;
  }[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  if (url.pathname === "/") url.pathname = "/avatar";
  url.searchParams.set("dbg", "1");
  url.searchParams.set("quality", "low");
  const snapshot = () =>
    page.evaluate(() => (window as any).__motionStudio.snapshot());

  async function direct(instruction: string, expected: string) {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/avatar/direct" &&
        response.request().postDataJSON().instruction === instruction,
      { timeout: 120_000 },
    );
    const started = Date.now();
    await page
      .getByRole("button", { name: "Apply direction", exact: true })
      .click();
    const response = await responsePromise;
    const result = await response.json();
    calls.push({
      instruction,
      status: response.status(),
      result,
      milliseconds: Date.now() - started,
    });
    expect(response.status()).toBe(200);
    expect(result.output).toBe(expected);
    await expect(
      page.getByRole("button", { name: "Apply direction", exact: true }),
    ).toBeEnabled({ timeout: 120_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    return snapshot();
  }

  async function checkHops(support: "left" | "right", count: number) {
    const current = await snapshot();
    expect(current.focus).toBe("body");
    expect(current.loop).toBe(false);
    expect(current.program.title).toContain(`Jump on the ${support} foot`);
    const timeline = compileMotion(current.program as MotionProgram);
    expect(timeline.duration).toBeCloseTo(
      (count * 2 * 60) / current.program.bpm,
    );
    const samples = await page.evaluate(
      ({ support, count }) => {
        const motion = (window as any).__motion;
        const free = support === "left" ? "right" : "left";
        motion.seek(0);
        const rest = motion.snapshot();
        const samples: { progress: number; support: number; free: number }[] =
          [];
        for (let frame = 0; frame <= 60 * count; frame++) {
          const progress = frame / (60 * count);
          motion.seek(motion.timeline.duration * progress);
          const pose = motion.snapshot();
          samples.push({
            progress,
            support:
              pose[`${support}_ankle`].position[1] -
              rest[`${support}_ankle`].position[1],
            free:
              pose[`${free}_ankle`].position[1] -
              rest[`${free}_ankle`].position[1],
          });
        }
        return samples;
      },
      { support, count },
    );
    let airborne = false;
    let takeoffs = 0;
    for (const sample of samples) {
      if (sample.support > 0.08 && !airborne) {
        takeoffs++;
        airborne = true;
      }
      if (sample.support < 0.02) airborne = false;
      if (
        sample.progress >= 0.18 / count &&
        sample.progress <= 1 - 0.16 / count
      )
        expect(
          sample.free,
          "The non-supporting foot stays raised between hops",
        ).toBeGreaterThan(0.22);
      expect(sample.support).toBeGreaterThanOrEqual(-0.001);
    }
    expect(takeoffs).toBe(count);
    expect(
      Math.max(...samples.map((sample) => sample.support)),
    ).toBeGreaterThan(0.32);
  }

  try {
    await page.goto(url.href);
    await page.waitForFunction(
      () => !!(window as any).__motionStudio && !!(window as any).__motion,
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Start over", exact: true }).click();
    const kick = await direct(
      "kick without moving arms",
      "action kick_right 1\narms still",
    );
    expect(kick.focus).toBe("body");
    expect(kick.loop).toBe(false);
    const armRotations = await page.evaluate(() => {
      const motion = (window as any).__motion;
      const targets = ["left", "right"].flatMap((side) =>
        ["clavicle", "shoulder", "elbow", "wrist"].map(
          (joint) => `${side}_${joint}`,
        ),
      );
      return [0, 0.2, 0.45, 0.7, 1].map((progress) => {
        motion.seek(progress * motion.timeline.duration);
        return targets.map((target) =>
          motion.rig.joints.get(target).bone.quaternion.toArray(),
        );
      });
    });
    for (const rotations of armRotations.slice(1))
      expect(rotations).toEqual(armRotations[0]);

    // Keep the kick playing while the remote stop request is in flight.
    await page.getByRole("checkbox", { name: "Loop", exact: true }).check();
    await page
      .getByRole("button", { name: "Replay current motion", exact: true })
      .click();
    const beforeStop = await snapshot();
    const stopped = await direct("stop", "playback pause");
    expect(stopped.playing).toBe(false);
    for (const key of [
      "program",
      "selected",
      "focus",
      "frozen",
      "cues",
      "origin",
      "loop",
    ])
      expect(stopped[key], `${key} survives stop`).toEqual(beforeStop[key]);
    await page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame++)
        await new Promise(requestAnimationFrame);
    });
    expect((await snapshot()).time).toBe(stopped.time);
    const resumed = await direct("resume", "playback resume");
    expect(resumed.program).toEqual(kick.program);
    expect(resumed.playing).toBe(true);
    await expect
      .poll(async () => (await snapshot()).time)
      .not.toBe(stopped.time);

    await direct("jump on left foot", "action jump 1 left");
    await checkHops("left", 1);
    await direct("Hop twice on your right leg", "action jump 2 right");
    await checkHops("right", 2);

    const running = await direct(
      "Run with your arms still",
      "action run 1\narms still",
    );
    expect(running.focus).toBe("body");
    expect(running.loop).toBe(true);
    const duration = compileMotion(running.program as MotionProgram).duration;
    await page.evaluate((duration) => {
      (window as any).__motionStudio.seek(duration - 0.15);
      (window as any).__motion.seek(duration - 0.15);
    }, duration);
    await page
      .getByRole("button", { name: "Play current motion", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).time)
      .toBeLessThan(duration - 0.2);
    expect((await snapshot()).playing).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("public-controls.png"),
      fullPage: true,
    });
  } finally {
    await testInfo.attach("live-control-requests", {
      body: JSON.stringify({ calls, errors }, null, 2),
      contentType: "application/json",
    });
  }
});
