import {
  expect,
  test,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import {
  createDexteritySequence,
  defaultDexteritySequenceCommands,
  getDexteritySequenceInstructions,
} from "../src/motion/dexteritySequence";
import { compileMotion, sampleContacts } from "../src/motion/engine";
import { currentMotionHand } from "../src/motion/relative";
import type { MotionProgram, Timeline } from "../src/motion/types";

// Real public PAW requests only; no route mocks, API clients or authored-scene injection.
// After deployment, run alone so the inference calls stay sequential:
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/tweet.spec.ts --workers=1
test.describe.configure({ mode: "serial" });
test.skip(
  process.env.AVATAR_LIVE_PUBLIC !== "1",
  "Opt in to the exact tweet phrases through live public inference.",
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

const instructions = getDexteritySequenceInstructions("left");
const commands = defaultDexteritySequenceCommands("left");
const isDirector = (url: string) =>
  new URL(url).pathname === "/api/v1/avatar/direct";
const publicURL = () => {
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  if (url.pathname === "/") url.pathname = "/avatar";
  url.searchParams.set("dbg", "1");
  url.searchParams.set("quality", "low");
  return url.href;
};
const studio = (page: Page) =>
  page.evaluate(() => (window as any).__motionStudio.snapshot());

function observe(page: Page, testInfo: TestInfo) {
  const calls: {
    instruction: string;
    status?: number;
    result?: any;
    timing?: ReturnType<Request["timing"]>;
  }[] = [];
  const byRequest = new Map<Request, (typeof calls)[number]>();
  const pending: Promise<void>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!isDirector(request.url())) return;
    const call = { instruction: request.postDataJSON().instruction };
    calls.push(call);
    byRequest.set(request, call);
  });
  page.on("response", (response) => {
    const call = byRequest.get(response.request());
    if (!call) return;
    pending.push(
      (async () => {
        call.status = response.status();
        call.result = await response.json();
        await response.finished();
        call.timing = response.request().timing();
      })(),
    );
  });
  return {
    calls,
    errors,
    async complete() {
      await Promise.all(pending);
    },
    async attach() {
      const results = await Promise.allSettled(pending);
      await testInfo.attach("live-tweet-requests", {
        body: JSON.stringify(
          {
            calls,
            errors,
            responseErrors: results.flatMap((result) =>
              result.status === "rejected" ? [String(result.reason)] : [],
            ),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    },
  };
}

async function ready(page: Page) {
  await page.goto(publicURL());
  await page.waitForFunction(
    () => !!(window as any).__motionStudio && !!(window as any).__motion,
    undefined,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  expect((await studio(page)).origin).toBe("Your motion");
}

async function direct(page: Page, instruction: string, expected: string) {
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const responsePromise = page.waitForResponse(
    (response) =>
      isDirector(response.url()) &&
      response.request().postDataJSON().instruction === instruction,
    { timeout: 120_000 },
  );
  await page
    .getByRole("button", { name: "Apply direction", exact: true })
    .click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect((await response.json()).output).toBe(expected);
  await expect(
    page.getByRole("button", { name: "Apply direction", exact: true }),
  ).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await studio(page);
  expect(current.caption).toBe(instruction);
  expect(current.focus).toBe("left_hand");
  expect(current.playing).toBe(true);
  expect(currentMotionHand(current.program)).toBe("left");
  await page.locator(".motion-stage").scrollIntoViewIfNeeded();
  return current.program as MotionProgram;
}

async function sampleRendered(page: Page, time: number, timeline: Timeline) {
  const activeContacts = sampleContacts(timeline, time);
  return page.evaluate(
    ({ time, activeContacts }) => {
      const motion = (window as any).__motion;
      (window as any).__motionStudio.seek(time);
      motion.seek(time);
      const tip = (id: string) => {
        const third = motion.rig.joints.get(id.replace("_tip", "_3")).bone;
        const bone = third.children.find((child: any) => child.isBone);
        return bone.getWorldPosition(bone.position.clone());
      };
      return {
        joints: motion.snapshot(),
        camera: motion.cameraSnapshot(),
        props: motion.rig.props.snapshot(),
        contacts: activeContacts.map((contact) =>
          contact.mode === "fingertips"
            ? {
                ...contact,
                distance: tip(contact.effector).distanceTo(tip(contact.target)),
              }
            : contact,
        ),
      };
    },
    { time, activeContacts },
  );
}

function expectHandCamera(sample: Awaited<ReturnType<typeof sampleRendered>>) {
  expect(sample.camera.focus).toBe("left_hand");
  expect(
    [
      ...sample.camera.position,
      ...sample.camera.target,
      ...sample.camera.up,
    ].every(Number.isFinite),
  ).toBe(true);
  const wrist = sample.joints.left_wrist.position;
  expect(
    Math.hypot(
      ...sample.camera.target.map(
        (value: number, index: number) => value - wrist[index],
      ),
    ),
  ).toBeLessThan(0.25);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.locator(".motion-stage").screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("each exact tweet phrase works when typed into a fresh public session", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const evidence = observe(page, testInfo);
  try {
    await ready(page);
    let expected = (await studio(page)).program as MotionProgram;
    const semanticEvidence: unknown[] = [];
    for (let index = 0; index < instructions.length; index++) {
      const actual = await direct(page, instructions[index], commands[index]);
      expected = applyCommands(expected, commands[index]);
      expect(actual).toEqual(expected);
      const timeline = validateRigProgram(actual);
      if (index <= 1) {
        expect(timeline.contacts ?? []).toEqual([]);
        const peaks = ["pinky", "thumb"].map((finger) => {
          const track = timeline.tracks.find(
            (track) =>
              track.target === `left_${finger}_1` &&
              track.curve.kind === "keys",
          )!;
          if (track.curve.kind !== "keys")
            throw new Error("Expected editable finger-pulse keys.");
          const peak = track.curve.points.reduce((best, point) =>
            Math.abs(point[1]) > Math.abs(best[1]) ? point : best,
          );
          return { finger, time: track.start + peak[0] * track.duration };
        });
        expect(peaks[0].time < peaks[1].time).toBe(index === 0);
        const rest = await sampleRendered(page, 0, timeline);
        for (const peak of peaks) {
          const rendered = await sampleRendered(page, peak.time, timeline);
          expectHandCamera(rendered);
          expect(rendered.props).toEqual({});
          expect(
            rendered.joints[`left_${peak.finger}_1`].quaternion,
          ).not.toEqual(rest.joints[`left_${peak.finger}_1`].quaternion);
          expect(rendered.joints.right_wrist).toEqual(rest.joints.right_wrist);
        }
        semanticEvidence.push({ instruction: instructions[index], peaks });
      } else if (index === 2) {
        const contacts = (timeline.contacts ?? []).filter(
          (contact) => contact.mode === "fingertips",
        );
        expect(
          contacts
            .slice(0, 4)
            .map((contact) => contact.mode === "fingertips" && contact.target),
        ).toEqual([
          "left_index_tip",
          "left_middle_tip",
          "left_ring_tip",
          "left_pinky_tip",
        ]);
        const gaps: number[] = [];
        for (const contact of contacts.slice(0, 4)) {
          const rendered = await sampleRendered(
            page,
            contact.start + contact.duration * 0.475,
            timeline,
          );
          expectHandCamera(rendered);
          expect(rendered.props).toEqual({});
          expect(rendered.contacts).toHaveLength(1);
          const held = rendered.contacts[0];
          expect(held.mode).toBe("fingertips");
          if (held.mode !== "fingertips")
            throw new Error("Expected a held fingertip contact.");
          expect(held.weight).toBe(1);
          expect(held.distance).toBeLessThan(0.003);
          gaps.push(held.distance);
        }
        semanticEvidence.push({
          instruction: instructions[index],
          fingertipGapsMetres: gaps,
        });
      } else {
        const contacts = (timeline.contacts ?? []).filter(
          (contact) => contact.mode === "prop_transfer",
        );
        expect(
          contacts
            .slice(0, 3)
            .map(
              (contact) =>
                contact.mode === "prop_transfer" && [contact.from, contact.to],
            ),
        ).toEqual([
          ["left_index_2", "left_middle_2"],
          ["left_middle_2", "left_ring_2"],
          ["left_ring_2", "left_pinky_2"],
        ]);
        expect(timeline.props?.map((prop) => prop.kind)).toEqual(["coin"]);
        const positions: number[][] = [];
        for (const contact of contacts.slice(0, 3)) {
          const rendered = await sampleRendered(
            page,
            contact.start + contact.duration * 0.5,
            timeline,
          );
          expectHandCamera(rendered);
          expect(rendered.props.coin.visible).toBe(true);
          expect(
            [
              ...rendered.props.coin.position,
              ...rendered.props.coin.quaternion,
            ].every(Number.isFinite),
          ).toBe(true);
          positions.push(rendered.props.coin.position);
        }
        expect(
          Math.hypot(
            ...positions[0].map((value, axis) => value - positions[2][axis]),
          ),
        ).toBeGreaterThan(0.01);
        semanticEvidence.push({
          instruction: instructions[index],
          coinPositions: positions,
        });
      }
      await capture(
        page,
        testInfo,
        [
          "01-pinky-to-thumb",
          "02-reversed-ripple",
          "03-fingertip-contact",
          "04-coin-on-knuckles",
        ][index],
      );
      await page
        .getByRole("button", { name: "Replay current motion", exact: true })
        .click();
      await page.waitForTimeout(index === 3 ? 3000 : 1700); // Preserve visible motion in the actual browser recording.
    }
    await evidence.complete();
    expect(evidence.calls.map((call) => call.instruction)).toEqual(
      instructions,
    );
    expect(evidence.calls.map((call) => call.result.output)).toEqual(commands);
    expect(evidence.errors).toEqual([]);
    await testInfo.attach("tweet-phrase-motion-checks", {
      body: JSON.stringify(semanticEvidence, null, 2),
      contentType: "application/json",
    });
  } finally {
    await evidence.attach();
  }
});

test("the PAW sequence button makes four real sequential calls and reproduces the tweet choreography", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const evidence = observe(page, testInfo);
  try {
    await ready(page);
    await page.locator("summary").filter({ hasText: "More motions" }).click();
    await page
      .getByRole("button", { name: "Recreate demo from prompts", exact: true })
      .click();
    await expect
      .poll(async () => (await studio(page)).origin, { timeout: 480_000 })
      .toBe("Your motion");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await evidence.complete();
    expect(evidence.calls).toHaveLength(4);
    expect(evidence.calls.map((call) => call.instruction)).toEqual(
      instructions,
    );
    expect(evidence.calls.map((call) => call.result.output)).toEqual(commands);
    expect(evidence.calls.every((call) => call.status === 200)).toBe(true);
    for (let index = 1; index < evidence.calls.length; index++) {
      const previous = evidence.calls[index - 1].timing!,
        current = evidence.calls[index].timing!;
      expect(previous.responseEnd).toBeGreaterThanOrEqual(0);
      expect(
        current.startTime + 2,
        "The next inference begins after the preceding response finishes",
      ).toBeGreaterThanOrEqual(previous.startTime + previous.responseEnd);
    }
    const actual = await studio(page),
      expected = createDexteritySequence(undefined, "left");
    expect(actual.program).toEqual(expected.program);
    expect(actual.cues).toEqual(expected.cues);
    expect(actual.loop).toBe(false);
    expect(actual.focus).toBe("left_hand");
    const timeline = compileMotion(actual.program);
    expect(timeline.duration).toBeCloseTo(16.8, 10);
    await page.locator("summary").filter({ hasText: "More motions" }).click();
    await page.locator(".motion-stage").scrollIntoViewIfNeeded();
    await page
      .getByRole("button", { name: "Replay current motion", exact: true })
      .click();
    await expect
      .poll(async () => (await studio(page)).playing, {
        timeout: 45_000,
        intervals: [500],
      })
      .toBe(false);
    expect((await studio(page)).time).toBeCloseTo(16.8, 2);
    for (const [name, time] of [
      ["sequence-ripple", 0.5],
      ["sequence-reverse", 3],
      ["sequence-fingertips", 5.4],
      ["sequence-coin", 13.4],
    ] as const) {
      const rendered = await sampleRendered(page, time, timeline);
      expectHandCamera(rendered);
      expect(rendered.props.coin?.visible ?? false).toBe(
        name === "sequence-coin",
      );
      if (name === "sequence-coin")
        expect(rendered.props.coin.visible).toBe(true);
      await capture(page, testInfo, name);
    }
    expect(evidence.errors).toEqual([]);
    await testInfo.attach("live-reconstructed-tweet-program", {
      body: JSON.stringify(actual.program, null, 2),
      contentType: "application/json",
    });
  } finally {
    await evidence.attach();
  }
});
