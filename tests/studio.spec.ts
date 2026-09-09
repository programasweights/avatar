import { expect, test, type Page } from "@playwright/test";

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

async function openSection(page: Page, name: "More motions" | "Edit motion") {
  const summary = page.locator("summary").filter({ hasText: name });
  const disclosure = summary.locator("..");
  if (
    !(await disclosure.evaluate(
      (element) => (element as HTMLDetailsElement).open,
    ))
  )
    await summary.click();
  await expect(disclosure).toHaveJSProperty("open", true);
}

test("the default showcase has chapters, no loop, and survives a JSON round trip", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Pause current motion", exact: true }).click();

  expect(
    await page.evaluate(() => (window as any).__motion.timeline.duration),
  ).toBeCloseTo(16.8);
  await expect(
    page.getByRole("checkbox", { name: "Loop", exact: true }),
  ).not.toBeChecked();
  await expect(page.locator(".motion-stage-label")).toHaveText(
    "Example · Hand sequence",
  );
  await openSection(page, "Edit motion");
  const chapters = page.getByRole("navigation", { name: "Sequence chapters" });
  await expect(chapters.getByRole("button")).toHaveCount(5);
  const examples = [
    {
      chapter: "Pinky → thumb",
      caption: "Make a wave from pinky to thumb on your left hand.",
    },
    {
      chapter: "Thumb → pinky",
      caption: "Reverse the finger ripple on your left hand.",
    },
    {
      chapter: "Thumb touches · index → pinky",
      caption: "Touch your left thumb to each fingertip, index first.",
    },
    { chapter: "Turn the hand", caption: "Turn the hand" },
    {
      chapter: "Roll across the knuckles",
      caption: "Roll a coin across your left knuckles.",
    },
  ];
  for (const example of examples) {
    const button = chapters.getByRole("button", {
      name: new RegExp(example.chapter),
    });
    await button.click();
    await expect(button).toHaveAttribute("aria-current", "step");
    await expect(page.locator(".motion-caption p")).toHaveText(example.caption);
  }

  const sample = () =>
    page.evaluate(() => {
      const motion = (window as any).__motion;
      return [6, 12].map((time) => {
        motion.seek(time);
        return {
          joints: motion.snapshot(),
          props: motion.rig.props.snapshot(),
        };
      });
    });
  const before = await sample();
  await page
    .getByRole("button", { name: "Edit motion JSON", exact: true })
    .click();
  const exported = await page
    .getByLabel("Motion JSON", { exact: true })
    .inputValue();
  const program = JSON.parse(exported);
  expect(program.root.id).toBe("dexterity_sequence");
  expect(program.root.kind).toBe("sequence");
  expect(program.props).toEqual([expect.objectContaining({ kind: "coin" })]);
  await page
    .getByRole("button", { name: "Apply program", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await sample()).toEqual(before);
  expect(
    await page.evaluate(() => (window as any).__motion.timeline.duration),
  ).toBeCloseTo(16.8);
  expect(errors).toEqual([]);
});

test("a typed skill replaces the showcase using a mocked PAW response", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const instruction = "Touch your left thumb to each fingertip, index first.";
  const requests: string[] = [];
  // This tests UI integration and command application, not model accuracy.
  await page.route("**/api/direct", async (route) => {
    requests.push(route.request().postDataJSON().instruction);
    await route.fulfill({
      json: {
        output: "skill finger_touches left forward",
        trace: [{ source: "mocked UI test" }],
      },
    });
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  await openSection(page, "Edit motion");
  await expect(
    page.getByRole("navigation", { name: "Sequence chapters" }),
  ).toBeVisible();
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  await expect(page.locator(".motion-stage-label")).toHaveText(
    "PAW · neural commands",
  );
  await expect(
    page.getByRole("navigation", { name: "Sequence chapters" }),
  ).toHaveCount(0);
  await expect(page.locator(".motion-caption p")).toHaveText(instruction);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests).toEqual([instruction]);
  const timeline = await page.evaluate(() => (window as any).__motion.timeline);
  expect(timeline.contacts.length).toBeGreaterThan(0);
  expect(
    timeline.contacts.every((contact: any) => contact.mode === "fingertips"),
  ).toBe(true);
  expect(
    timeline.tracks.some((track: any) => track.target === "left_hand_camera"),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Edit motion JSON", exact: true })
    .click();
  const program = JSON.parse(
    await page.getByLabel("Motion JSON", { exact: true }).inputValue(),
  );
  expect(program.root.kind).toBe("parallel");
  expect(program.root.children.some((node: any) => node.id === "arms")).toBe(
    true,
  );
});

test("cancelling a sequence ignores a late mocked response and keeps the next scene", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/direct", async (route) => {
    requests.push(route.request().postDataJSON().instruction);
    if (requests.length === 1) {
      await route.fulfill({
        json: { output: "skill finger_ripple left forward" },
      });
      return;
    }
    await released;
    // The browser may already have aborted this intercepted request.
    try {
      await route.fulfill({
        json: { output: "skill finger_ripple left reverse" },
      });
    } catch {
      /* Aborting is an expected result of the Cancel action. */
    } finally {
      finish();
    }
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  await openSection(page, "More motions");
  await page
    .getByRole("button", { name: "Load hand demo through PAW", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(
    page.getByRole("status", { name: "Sequence progress" }),
  ).toContainText("2 / 4");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Sequence progress" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Salsa", exact: true }).click();
  release();
  await finished;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".motion-caption p")).toHaveText("Dance salsa.");
  await expect(page.locator(".motion-stage-label")).toHaveText(
    "Example · Salsa",
  );
  expect(requests).toHaveLength(2);
});

test("studio renders, scrubs deterministically, and edits only one finger", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log("AVATAR PAGE ERROR:", error.message);
  });
  await page.goto("/?dbg=1&quality=low");
  await expect(
    page.getByRole("heading", { name: "Tell the character what to do." }),
  ).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  await openSection(page, "More motions");
  await page.getByRole("button", { name: "Salsa", exact: true }).click();
  await page.getByRole("button", { name: "Pause current motion", exact: true }).click();
  const snapshot = async (time: number) =>
    page.evaluate(async (t) => {
      await new Promise(requestAnimationFrame);
      const d = (window as any).__motion;
      d.seek(t);
      return d.snapshot();
    }, time);
  const before = await snapshot(1);
  await openSection(page, "Edit motion");
  await page.getByLabel("Arm choreography", { exact: true }).selectOption("robot");
  await page.waitForFunction(() =>
    (window as any).__motion.timeline.tracks.some(
      (t: any) => t.id === "arms.left.shoulder.x" && t.curve.kind === "keys",
    ),
  );
  const after = await snapshot(1);
  expect(after.left_ankle.position).toEqual(before.left_ankle.position);
  expect(after.right_ankle.position).toEqual(before.right_ankle.position);
  expect(after.left_elbow.quaternion).not.toEqual(before.left_elbow.quaternion);
  const baseline = await snapshot(0);
  await openSection(page, "Edit motion");
  await page.getByLabel("Joint angle", { exact: true }).fill("65");
  await page.waitForFunction(() =>
    (window as any).__motion.timeline.tracks.some(
      (t: any) => t.id === "detail.left_index_1.z",
    ),
  );
  const finger = await snapshot(0);
  for (const id of [
    "head",
    "left_shoulder",
    "left_wrist",
    "right_index_1",
    "left_ankle",
  ])
    expect(finger[id]).toEqual(baseline[id]);
  expect(finger.left_index_1.quaternion).not.toEqual(
    baseline.left_index_1.quaternion,
  );
  expect(await snapshot(0)).toEqual(finger);
  await page
    .getByRole("button", { name: "Edit motion JSON", exact: true })
    .click();
  const exported = await page
    .getByLabel("Motion JSON", { exact: true })
    .inputValue();
  expect(JSON.parse(exported).version).toBe(2);
  await page.getByLabel("Motion JSON", { exact: true }).fill('{"version":99}');
  await page
    .getByRole("button", { name: "Apply program", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Motion JSON", { exact: true }).fill(exported);
  await page
    .getByRole("button", { name: "Apply program", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("live PAW moves the left thumb from an unsuffixed finger request", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.AVATAR_LIVE_PAW !== "1",
    "Set AVATAR_LIVE_PAW=1 to run the published PAW functions locally.",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  const before = await page.evaluate(() => {
    const motion = (window as any).__motion;
    motion.seek(0);
    return motion.snapshot();
  });
  await page
    .getByLabel("Direction", { exact: true })
    .fill("move your left thumb");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/direct") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const response = await responsePromise;
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBe(true);
  expect(result.output).toBe("joint left_thumb_1 z 45");
  await page.waitForFunction(() =>
    (window as any).__motion.timeline.tracks.some(
      (t: any) => t.id === "detail.left_thumb_1.z",
    ),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  const after = await page.evaluate(() => {
    const motion = (window as any).__motion;
    motion.seek(0);
    return motion.snapshot();
  });
  expect(after.left_thumb_1.quaternion).not.toEqual(
    before.left_thumb_1.quaternion,
  );
  // Descendants follow the thumb in world space; no other joint's local
  // rotation should change when adding this single control.
  for (const joint of Object.keys(before)) {
    if (joint !== "left_thumb_1")
      expect(after[joint].quaternion, joint).toEqual(before[joint].quaternion);
  }
  expect(errors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("thumb-regression.png"),
    fullPage: true,
  });
});

test("all 52 rig joints rotate on every axis and hip rotations lift each leg in the intended direction", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  const result = await page.evaluate(() => {
    const motion = (window as any).__motion;
    motion.seek(0);
    const rig = motion.rig;
    rig.apply([]);
    const before = rig.snapshot();
    const failures: string[] = [];
    let checked = 0;
    for (const target of Object.keys(before)) {
      for (const axis of ["x", "y", "z"]) {
        rig.apply([{ target, channel: "rotation", axis, value: 17 }]);
        const after = rig.snapshot();
        if (
          after[target].quaternion.every(
            (value: number, i: number) =>
              Math.abs(value - before[target].quaternion[i]) < 1e-6,
          )
        )
          failures.push(`${target}.${axis}`);
        checked++;
      }
    }
    const legs = [];
    for (const side of ["left", "right"]) {
      for (const [direction, axis, value] of [
        ["forward", "x", -45],
        ["backward", "x", 30],
        ["outward", "z", side === "left" ? 40 : -40],
      ]) {
        rig.apply([
          { target: `${side}_hip`, channel: "rotation", axis, value },
        ]);
        const after = rig.snapshot();
        const ankle = `${side}_ankle`,
          other = `${side === "left" ? "right" : "left"}_ankle`;
        legs.push({
          side,
          direction,
          delta: after[ankle].position.map(
            (v: number, i: number) => v - before[ankle].position[i],
          ),
          otherMoved: after[other].position.some(
            (v: number, i: number) =>
              Math.abs(v - before[other].position[i]) > 1e-6,
          ),
        });
      }
    }
    return { jointCount: Object.keys(before).length, checked, failures, legs };
  });
  expect(result.jointCount).toBe(52);
  expect(result.checked).toBe(156);
  expect(result.failures).toEqual([]);
  for (const leg of result.legs) {
    expect(
      leg.delta[1],
      `${leg.side} ${leg.direction} lifts the foot`,
    ).toBeGreaterThan(0.05);
    expect(leg.otherMoved).toBe(false);
    if (leg.direction === "forward") expect(leg.delta[2]).toBeGreaterThan(0.2);
    if (leg.direction === "backward") expect(leg.delta[2]).toBeLessThan(-0.2);
    if (leg.direction === "outward")
      expect(leg.delta[0] * (leg.side === "left" ? 1 : -1)).toBeGreaterThan(
        0.2,
      );
  }
});

test("live PAW lifts a leg after a finger close-up and selects its joint control", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.AVATAR_LIVE_PAW !== "1",
    "Set AVATAR_LIVE_PAW=1 to run the published PAW functions locally.",
  );
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "One finger", exact: true }).click();
  await page.waitForFunction(() =>
    (window as any).__motion.timeline.tracks.some(
      (t: any) => t.id === "detail.left_index_1.z",
    ),
  );
  const before = await page.evaluate(() => {
    const m = (window as any).__motion;
    m.seek(0);
    return m.snapshot();
  });
  await page
    .getByLabel("Direction", { exact: true })
    .fill("lift up your left leg");
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/direct") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const response = await responsePromise;
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBe(true);
  expect(result.output).toBe("joint left_hip x -45");
  await page.waitForFunction(() =>
    (window as any).__motion.timeline.tracks.some(
      (t: any) => t.id === "detail.left_hip.x",
    ),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await openSection(page, "Edit motion");
  await expect(page.getByLabel("Joint", { exact: true })).toHaveValue(
    "left_hip",
  );
  await expect(page.getByLabel("Joint axis", { exact: true })).toHaveValue("x");
  await expect(page.getByLabel("Joint angle", { exact: true })).toHaveValue(
    "-45",
  );
  const after = await page.evaluate(() => {
    const m = (window as any).__motion;
    m.seek(0);
    return m.snapshot();
  });
  expect(
    after.left_ankle.position[1] - before.left_ankle.position[1],
  ).toBeGreaterThan(0.05);
  expect(
    after.left_ankle.position[2] - before.left_ankle.position[2],
  ).toBeGreaterThan(0.2);
  expect(after.right_ankle.position).toEqual(before.right_ankle.position);
  await page.screenshot({
    path: testInfo.outputPath("leg-lift.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Direction", { exact: true })
    .fill("Raise both arms 60 degrees");
  const armsResponsePromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/direct") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const armsResponse = await armsResponsePromise;
  expect(armsResponse.ok()).toBe(true);
  expect((await armsResponse.json()).output).toBe(
    "joint left_shoulder z 60\njoint right_shoulder z -60",
  );
  await page.waitForFunction(() =>
    (window as any).__motion.timeline.tracks.some(
      (t: any) => t.id === "detail.right_shoulder.z",
    ),
  );
  const arms = await page.evaluate(() => {
    const m = (window as any).__motion;
    m.seek(0);
    return m.snapshot();
  });
  for (const side of ["left", "right"]) {
    expect(arms[`${side}_ankle`].position).toEqual(
      after[`${side}_ankle`].position,
    );
    expect(
      arms[`${side}_wrist`].position[1] - after[`${side}_wrist`].position[1],
    ).toBeGreaterThan(0.2);
  }
  await page.screenshot({
    path: testInfo.outputPath("leg-and-arms.png"),
    fullPage: true,
  });
});

test("the focused studio fits desktop and keeps mobile controls reachable without horizontal scrolling", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?dbg=1&quality=low");
  await expect(
    page.getByRole("heading", { name: "Tell the character what to do." }),
  ).toBeVisible();
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });

  const editSummary = page
    .locator("summary")
    .filter({ hasText: "Edit motion" });
  const moreSummary = page
    .locator("summary")
    .filter({ hasText: "More motions" });
  await expect(editSummary.locator("..")).toHaveJSProperty("open", false);
  await expect(moreSummary.locator("..")).toHaveJSProperty("open", false);
  await expect(page.locator(".motion-inspector")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Replay current motion", exact: true }),
  ).toBeVisible();

  const stage = await page
    .getByRole("region", { name: "Avatar preview", exact: true })
    .boundingBox();
  const direction = await page
    .getByLabel("Direction", { exact: true })
    .boundingBox();
  expect(stage).not.toBeNull();
  expect(direction).not.toBeNull();
  expect(stage!.y).toBeGreaterThanOrEqual(0);
  expect(
    stage!.y + stage!.height,
    "The complete desktop stage should fit above the fold",
  ).toBeLessThanOrEqual(page.viewportSize()!.height + 12);
  expect(
    stage!.width,
    "The character should remain the main visual",
  ).toBeGreaterThan(400);
  expect(
    direction!.x,
    "Desktop instructions should sit beside the stage",
  ).toBeGreaterThanOrEqual(stage!.x + stage!.width - 12);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  const expectNoHorizontalScroll = async () => {
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      content: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 2);
  };
  await expectNoHorizontalScroll();
  await expect(editSummary.locator("..")).toHaveJSProperty("open", false);
  await page.getByRole("button", { name: "One finger", exact: true }).click();
  await expect(page.locator(".motion-caption p")).toHaveText(
    "Wiggle only the left index finger 65 degrees.",
  );
  await page
    .getByLabel("Direction", { exact: true })
    .fill("Move your left thumb");
  await expect(
    page.getByRole("button", { name: "Apply direction", exact: true }),
  ).toBeEnabled();
  await openSection(page, "More motions");
  await page.getByRole("button", { name: "Salsa", exact: true }).click();
  await expect(page.locator(".motion-caption p")).toHaveText("Dance salsa.");
  await openSection(page, "Edit motion");
  await page.getByLabel("Joint angle", { exact: true }).fill("30");
  await expect(page.getByLabel("Joint angle", { exact: true })).toHaveValue(
    "30",
  );
  await expectNoHorizontalScroll();
  await page
    .getByRole("button", { name: "Edit motion JSON", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Motion program JSON" }),
  ).toBeVisible();
  await expect(page.getByLabel("Motion JSON", { exact: true })).toBeEditable();
  await expectNoHorizontalScroll();
  await page
    .getByRole("button", { name: "Close JSON editor", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});
