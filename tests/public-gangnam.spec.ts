import { expect, test } from "@playwright/test";
import { compileMotion, findNode } from "../src/motion/engine";
import type { MotionProgram } from "../src/motion/types";

// Real deployed UI requests only. Run alone after deployment:
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/public-gangnam.spec.ts --workers=1
test.describe.configure({ mode: "serial" });
test.skip(
  process.env.AVATAR_LIVE_PUBLIC !== "1",
  "Opt in to the Gangnam showcase through real public inference.",
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

test("public Gangnam directions change support feet while preserving the dance and costume", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  const requests: string[] = [];
  const calls: {
    instruction: string;
    status?: number;
    result?: any;
    milliseconds?: number;
  }[] = [];
  const rendered: unknown[] = [];
  const isDirector = (url: string) =>
    new URL(url).pathname === "/api/v1/avatar/direct";
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && isDirector(request.url()))
      requests.push(request.postDataJSON().instruction);
  });
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  if (url.pathname === "/") url.pathname = "/avatar";
  url.searchParams.delete("example");
  url.searchParams.set("character", "jade");
  url.searchParams.set("dbg", "1");
  url.searchParams.set("quality", "low");
  const snapshot = () =>
    page.evaluate(() => (window as any).__motionStudio.snapshot());

  async function direct(instruction: string, expected: string) {
    await page.getByLabel("Direction", { exact: true }).fill(instruction);
    const responsePromise = page.waitForResponse(
      (response) =>
        isDirector(response.url()) &&
        response.request().postDataJSON().instruction === instruction,
      { timeout: 120_000 },
    );
    const call: (typeof calls)[number] = { instruction };
    calls.push(call);
    const started = Date.now();
    await page
      .getByRole("button", { name: "Apply direction", exact: true })
      .click();
    const response = await responsePromise;
    call.status = response.status();
    call.result = await response.json();
    await response.finished();
    call.milliseconds = Date.now() - started;
    expect(call.status).toBe(200);
    expect(call.result.output).toBe(expected);
    expect(call.result.trace).toMatchObject(
      expected === "playback pause"
        ? { playback_control: "pause", route: "playback" }
        : { dance_extension: expected, dance_confirmation: "yes" },
    );
    await expect(
      page.getByRole("button", { name: "Apply direction", exact: true }),
    ).toBeEnabled({ timeout: 120_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    const current = await snapshot();
    expect(current.character).toBe("gangnam");
    expect(current.focus).toBe("body");
    expect(current.origin).toBe("Your motion");
    expect(current.playing).toBe(expected !== "playback pause");
    if (expected !== "playback pause") expect(current.caption).toBe(instruction);
    // Wait for the live rendered rig to receive this exact editor program.
    await expect
      .poll(() => page.evaluate(() => (window as any).__motion?.timeline), {
        timeout: 60_000,
      })
      .toEqual(compileMotion(current.program as MotionProgram));
    return current;
  }

  function expectPreserved(original: MotionProgram, current: MotionProgram) {
    expect(current.bpm).toBe(original.bpm);
    expect(compileMotion(current).duration).toBe(compileMotion(original).duration);
    for (const id of ["arms", "details", "torso.groove"]) {
      const before = findNode(original.root, id);
      expect(before, `The ${id} branch exists`).toBeDefined();
      expect(findNode(current.root, id), `${id} survives a support edit`).toEqual(before);
    }
  }

  async function sampleFeet(support: "both" | "left" | "right") {
    const evidence = await page.evaluate((support) => {
      const motion = (window as any).__motion;
      const studio = (window as any).__motionStudio;
      const program = studio.snapshot().program;
      const rest = Object.fromEntries(
        ["left", "right"].map((side) => [
          side,
          motion.rig.joints.get(`${side}_ankle`).worldPosition.y as number,
        ]),
      );
      const samples = [0.01, 0.25, 0.48, 1.48, 4.25, 7.5, 10, 10.5, 11.5, 14.5, 15.99].map((beat) => {
        const time = (beat * 60) / program.bpm;
        studio.seek(time);
        motion.seek(time);
        const pose = motion.snapshot();
        return {
          beat,
          left: pose.left_ankle.position[1] - rest.left,
          right: pose.right_ankle.position[1] - rest.right,
          finite: Object.values(pose).every((joint: any) =>
            [...joint.position, ...joint.quaternion].every(Number.isFinite),
          ),
        };
      });
      // Leave a representative pose for the screenshot and recorded video.
      studio.seek((10.5 * 60) / program.bpm);
      motion.seek((10.5 * 60) / program.bpm);
      return { support, rest, samples, camera: motion.cameraSnapshot() };
    }, support);
    rendered.push(evidence);
    expect(evidence.camera.focus).toBe("body");
    for (const sample of evidence.samples) {
      expect(sample.finite).toBe(true);
      if (support !== "both") {
        const free = support === "left" ? "right" : "left";
        expect(sample[free], `Raised ${free} ankle at beat ${sample.beat}`).toBeGreaterThan(0.34);
        expect(sample[support], `Supporting ${support} ankle at beat ${sample.beat}`).toBeLessThan(0.055);
        expect(sample[support]).toBeGreaterThan(-0.005);
        expect(sample[free] - sample[support]).toBeGreaterThan(0.3);
      }
    }
    if (support === "both") {
      const rightLift = evidence.samples.find((sample) => sample.beat === 0.48)!;
      const leftLift = evidence.samples.find((sample) => sample.beat === 1.48)!;
      expect(rightLift.right).toBeGreaterThan(0.19);
      expect(rightLift.left).toBeLessThan(0.055);
      expect(leftLift.left).toBeGreaterThan(0.19);
      expect(leftLift.right).toBeLessThan(0.055);
      expect(Math.abs(evidence.samples[0].left)).toBeLessThan(0.015);
      expect(Math.abs(evidence.samples[0].right)).toBeLessThan(0.015);
    }
  }

  async function capture(name: string) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.locator(".motion-stage").scrollIntoViewIfNeeded();
    await page.locator(".motion-stage").screenshot({ path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  }

  try {
    await page.goto(url.href);
    await page.waitForFunction(
      () => !!(window as any).__motionStudio && !!(window as any).__motion,
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Start over", exact: true }).click();
    expect((await snapshot()).character).toBe("jade");
    expect((await snapshot()).program.dance).toBeUndefined();

    const initial = await direct("Dance Gangnam Style.", "dance gangnam");
    expect(initial.program.dance).toEqual({ style: "gangnam", support: "both" });
    expect(initial.program.bpm).toBe(132);
    expect(initial.loop).toBe(true);
    await page.waitForFunction(() => {
      let hasTuxedo = false;
      (window as any).__motion?.rig.scene.traverse((object: any) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        if (materials.some((material: any) => material?.name === "Cobalt blue wool tuxedo"))
          hasTuxedo = true;
      });
      return hasTuxedo;
    }, undefined, { timeout: 60_000 });
    await sampleFeet("both");
    await capture("gangnam-original");

    const left = await direct("Now on one foot.", "support left");
    expect(left.program.dance).toEqual({ style: "gangnam", support: "left" });
    expectPreserved(initial.program, left.program);
    await sampleFeet("left");
    await capture("gangnam-left-support");

    const right = await direct("Switch feet", "support other");
    expect(right.program.dance).toEqual({ style: "gangnam", support: "right" });
    expectPreserved(initial.program, right.program);
    await sampleFeet("right");
    await capture("gangnam-right-support");

    const both = await direct("Both feet again.", "support both");
    expect(both.program.dance).toEqual({ style: "gangnam", support: "both" });
    expectPreserved(initial.program, both.program);
    await sampleFeet("both");
    await page.getByRole("button", { name: "Play current motion", exact: true }).click();
    const beforeStop = await snapshot();
    expect(beforeStop.playing).toBe(true);
    const stopped = await direct("stop", "playback pause");
    for (const key of ["program", "character", "focus", "loop", "selected", "frozen", "cues", "origin"])
      expect(stopped[key], `${key} survives stop`).toEqual(beforeStop[key]);
    const heldPose = await page.evaluate(() => (window as any).__motion.snapshot());
    await page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame);
    });
    expect((await snapshot()).time).toBe(stopped.time);
    expect(await page.evaluate(() => (window as any).__motion.snapshot())).toEqual(heldPose);
    expect(requests).toEqual([
      "Dance Gangnam Style.", "Now on one foot.", "Switch feet", "Both feet again.", "stop",
    ]);
    expect(errors).toEqual([]);
    await capture("gangnam-stopped");
  } finally {
    await testInfo.attach("live-gangnam-requests", {
      body: JSON.stringify({ calls, requests, rendered, errors }, null, 2),
      contentType: "application/json",
    });
  }
});
