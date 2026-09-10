import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";
import { compileMotion, findNode } from "../src/motion/engine";

// Run alone after deployment. Every instruction uses the real public API.
// AVATAR_LIVE_PUBLIC=1 BASE_URL=https://programasweights.com npx playwright test tests/public-posture-followups.spec.ts --workers=1
test.skip(process.env.AVATAR_LIVE_PUBLIC !== "1", "Opt in to real public posture and follow-up inference.");
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 960 }, video: "on", launchOptions: { args: [
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader",
] } });

type Evidence = { calls: unknown[]; samples: unknown[]; errors: string[] };
const evidence = new WeakMap<Page, Evidence>();
const state = (page: Page) => page.evaluate(() => (window as any).__motionStudio.snapshot());
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
const angle = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1,
  Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)) / (Math.hypot(...a) * Math.hypot(...b)),
));
const armJoints = (side: string) => ["clavicle", "shoulder", "elbow", "wrist"].map(joint => `${side}_${joint}`);
const legs = ["left", "right"].flatMap(side => ["hip", "knee", "ankle", "toes"].map(joint => `${side}_${joint}`));

test.beforeEach(async ({ page }) => {
  test.setTimeout(600_000);
  const record: Evidence = { calls: [], samples: [], errors: [] };
  evidence.set(page, record);
  page.on("pageerror", error => record.errors.push(error.message));
  const url = new URL(process.env.BASE_URL || "https://programasweights.com");
  expect(url.origin, "This opt-in test must use the deployed public service.").toBe("https://programasweights.com");
  url.pathname = "/gangnam";
  url.search = "?dbg=1&quality=low";
  await page.goto(url.href);
  await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion, undefined, { timeout: 90_000 });
  expect((await state(page)).character).toBe("gangnam");
  expect((await state(page)).program.dance.style).toBe("gangnam");
  await expect.poll(() => page.evaluate(() => (window as any).__motion.cameraSnapshot().transitioning)).toBe(false);
});

test.afterEach(async ({ page }, testInfo) => {
  const record = evidence.get(page)!;
  await testInfo.attach("public-inputs-and-rendered-poses", { body: JSON.stringify(record, null, 2), contentType: "application/json" });
  if (!page.isClosed()) await screenshot(page, testInfo, "final-state");
  expect(record.errors).toEqual([]);
});

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function direct(page: Page, instruction: string, expected: string) {
  await page.getByLabel("Direction", { exact: true }).fill(instruction);
  const responsePromise = page.waitForResponse(response => {
    const request = response.request(), url = new URL(response.url());
    return request.method() === "POST" && url.origin === "https://programasweights.com"
      && url.pathname === "/api/v1/avatar/direct" && request.postDataJSON().instruction === instruction;
  }, { timeout: 180_000 });
  const started = Date.now();
  await page.getByRole("button", { name: "Apply direction", exact: true }).click();
  const response = await responsePromise, result = await response.json();
  evidence.get(page)!.calls.push({ instruction, status: response.status(), result, elapsedMs: Date.now() - started });
  expect(response.status()).toBe(200);
  expect(result.output).toBe(expected);
  await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled({ timeout: 180_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const current = await state(page);
  await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline), { timeout: 30_000 }).toEqual(compileMotion(current.program));
  await expect.poll(() => page.evaluate(() => (window as any).__motion.cameraSnapshot().transitioning)).toBe(false);
  expect(current.focus).toBe("body");
  return current;
}

async function sample(page: Page, time: number, inspectGround = false) {
  const value = await page.evaluate(({ time, inspectGround }) => {
    const studio = (window as any).__motionStudio, motion = (window as any).__motion;
    studio.seek(time); motion.seek(time);
    let minY: number | null = null, minMesh = "";
    if (inspectGround) {
      const vector = motion.rig.scene.position.clone();
      motion.rig.scene.traverse((mesh: any) => {
        if (!mesh.isMesh || !mesh.geometry.attributes.position || !mesh.visible) return;
        for (let index = 0; index < mesh.geometry.attributes.position.count; index++) {
          mesh.getVertexPosition(index, vector); vector.applyMatrix4(mesh.matrixWorld);
          if (minY === null || vector.y < minY) { minY = vector.y; minMesh = mesh.name; }
        }
      });
    }
    return { time, pose: motion.snapshot(), camera: motion.cameraSnapshot(), minY, minMesh };
  }, { time, inspectGround });
  evidence.get(page)!.samples.push(value);
  const box = await page.locator(".motion-stage canvas").boundingBox();
  expect(box).not.toBeNull();
  const camera = new PerspectiveCamera(30, box!.width / box!.height, .1, 1000);
  camera.position.fromArray(value.camera.position); camera.up.fromArray(value.camera.up);
  camera.lookAt(new Vector3().fromArray(value.camera.target)); camera.updateMatrixWorld();
  expect(value.camera.focus).toBe("body");
  for (const [joint, pose] of Object.entries(value.pose) as [string, { position: number[]; quaternion: number[] }][]) {
    expect([...pose.position, ...pose.quaternion].every(Number.isFinite)).toBe(true);
    const screen = new Vector3().fromArray(pose.position).project(camera);
    expect(Math.abs(screen.x), `${joint} fits the normal camera horizontally at ${time}`).toBeLessThan(.98);
    expect(Math.abs(screen.y), `${joint} fits the normal camera vertically at ${time}`).toBeLessThan(.98);
  }
  if (inspectGround) {
    expect(value.minY).not.toBeNull();
    expect(value.minY!, `${value.minMesh} stays above the floor at ${time}`).toBeGreaterThan(-.02);
  }
  return value;
}

async function play(page: Page) {
  if (!(await state(page)).playing) await page.getByRole("button", { name: "Play current motion", exact: true }).click();
}

test("the exact full-left and full-right arm requests reach overhead without changing the other arm or feet", async ({ page }, testInfo) => {
  for (const side of ["left", "right"] as const) {
    const before = await state(page), duration = compileMotion(before.program).duration;
    const fractions = [.1, .3, .55, .8];
    const baseline = [];
    for (const fraction of fractions) baseline.push(await sample(page, duration * fraction));
    const instruction = `fully lift up ${side} arm`;
    const current = await direct(page, instruction, `arm ${side} still\njoint ${side}_shoulder z ${side === "left" ? 180 : -180}`);
    expect(current.program.dance).toEqual(before.program.dance);
    expect(compileMotion(current.program).duration).toBe(duration);
    for (const branch of ["feet", "torso"]) expect(findNode(current.program.root, branch)).toEqual(findNode(before.program.root, branch));
    const other = side === "left" ? "right" : "left";
    for (const [index, fraction] of fractions.entries()) {
      const { pose } = await sample(page, duration * fraction);
      const upper = new Vector3().fromArray(pose[`${side}_elbow`].position).sub(new Vector3().fromArray(pose[`${side}_shoulder`].position)).normalize();
      const lower = new Vector3().fromArray(pose[`${side}_wrist`].position).sub(new Vector3().fromArray(pose[`${side}_elbow`].position)).normalize();
      expect(upper.dot(lower), "The entire arm reaches straight upward.").toBeGreaterThan(.995);
      expect(upper.y).toBeGreaterThan(.94);
      expect(pose[`${side}_wrist`].position[1] - pose.head.position[1]).toBeGreaterThan(.23);
      for (const joint of [...armJoints(other), ...legs, "head", "hips"])
        expect(distance(pose[joint].position, baseline[index].pose[joint].position), `${joint} keeps its dance phase`).toBeLessThan(1e-6);
    }
    await expect(page.locator(".motion-caption p")).toHaveText(instruction);
    await screenshot(page, testInfo, `${side}-arm-overhead`);
  }
});

test("stopping leg movements freezes the actual legs while arms dance, and resuming footwork restores the program", async ({ page }, testInfo) => {
  const original = await state(page), duration = compileMotion(original.program).duration;
  const fractions = [.05, .2, .35, .55, .7, .9];
  const baseline = [];
  for (const fraction of fractions) baseline.push(await sample(page, duration * fraction));
  await play(page);
  const frozen = await direct(page, "stop leg movements", "freeze both_legs");
  expect(frozen.playing).toBe(true);
  expect(frozen.frozen.flatMap((token: any) => token.targets).sort()).toEqual([...legs].sort());
  const held = await sample(page, duration * fractions[0]);
  let armMovement = 0;
  for (const [index, fraction] of fractions.entries()) {
    const current = await sample(page, duration * fraction);
    for (const joint of [...legs, "hips"]) {
      expect(distance(current.pose[joint].position, held.pose[joint].position), `${joint} stays still`).toBeLessThan(1e-6);
      expect(angle(current.pose[joint].quaternion, held.pose[joint].quaternion)).toBeLessThan(1e-5);
    }
    for (const joint of [...armJoints("left"), ...armJoints("right")]) {
      expect(angle(current.pose[joint].quaternion, baseline[index].pose[joint].quaternion), `${joint} keeps its phase`).toBeLessThan(1e-5);
      armMovement = Math.max(armMovement, angle(current.pose[joint].quaternion, held.pose[joint].quaternion));
    }
  }
  expect(armMovement).toBeGreaterThan(.1);
  await screenshot(page, testInfo, "legs-still-arms-dancing");
  const restored = await direct(page, "resume the footwork", "restore both_legs");
  expect(restored.program).toEqual(original.program);
  expect(restored.frozen).toEqual([]);
  expect(restored.playing).toBe(true);
  let footMovement = 0;
  for (const [index, fraction] of fractions.entries()) {
    const current = await sample(page, duration * fraction);
    for (const joint of legs) expect(distance(current.pose[joint].position, baseline[index].pose[joint].position)).toBeLessThan(1e-6);
    footMovement = Math.max(footMovement, distance(current.pose.left_ankle.position, baseline[0].pose.left_ankle.position),
      distance(current.pose.right_ankle.position, baseline[0].pose.right_ankle.position));
  }
  expect(footMovement).toBeGreaterThan(.05);
  await screenshot(page, testInfo, "footwork-restored");
});

test("stop and resume dancing pause and resume playback without replacing the current routine", async ({ page }, testInfo) => {
  const original = await state(page);
  await play(page);
  const stopped = await direct(page, "stop", "playback pause");
  expect(stopped.playing).toBe(false);
  expect(stopped.program).toEqual(original.program);
  expect(stopped.frozen).toEqual(original.frozen);
  const stoppedTime = stopped.time;
  const firstPose = await page.evaluate(() => (window as any).__motion.snapshot());
  await page.waitForTimeout(350);
  expect((await state(page)).time).toBe(stoppedTime);
  expect(await page.evaluate(() => (window as any).__motion.snapshot())).toEqual(firstPose);
  await screenshot(page, testInfo, "global-stop");
  const resumed = await direct(page, "resume dancing", "playback resume");
  expect(resumed.playing).toBe(true);
  expect(resumed.program).toEqual(original.program);
  expect(resumed.frozen).toEqual(original.frozen);
  const duration = compileMotion(original.program).duration;
  await expect.poll(async () => ((await state(page)).time - resumed.time + duration) % duration, { timeout: 10_000 }).toBeGreaterThan(.05);
  await screenshot(page, testInfo, "same-dance-resumed");
});

test("kneel down and the visitor typo ly down produce distinct grounded postures in the public camera", async ({ page }, testInfo) => {
  const kneeling = await direct(page, "kneel down", "action kneel 1");
  expect(kneeling.loop).toBe(false);
  const kneelDuration = compileMotion(kneeling.program).duration;
  const upright = await sample(page, 0, true);
  await sample(page, kneelDuration * .4, true);
  const knees = await sample(page, kneelDuration, true);
  for (const side of ["left", "right"]) {
    expect(knees.pose[`${side}_knee`].position[1]).toBeLessThan(.11);
    expect(knees.pose[`${side}_knee`].position[1]).toBeGreaterThan(.04);
    expect(knees.pose[`${side}_knee`].position[2] - knees.pose[`${side}_ankle`].position[2]).toBeGreaterThan(.4);
  }
  expect(upright.pose.hips.position[1] - knees.pose.hips.position[1]).toBeGreaterThan(.45);
  expect(knees.pose.head.position[1] - knees.pose.hips.position[1]).toBeGreaterThan(.6);
  await expect(page.locator(".motion-caption p")).toHaveText("kneel down");
  await screenshot(page, testInfo, "kneeling-on-both-knees");

  const lying = await direct(page, "ly down", "action lie_down 1");
  expect(lying.loop).toBe(false);
  const lieDuration = compileMotion(lying.program).duration;
  for (const fraction of [.35, .5, .65]) await sample(page, lieDuration * fraction, true);
  const floor = await sample(page, lieDuration, true);
  expect(floor.pose.head.position[1]).toBeGreaterThan(.1);
  expect(floor.pose.head.position[1]).toBeLessThan(.2);
  expect(Math.abs(floor.pose.head.position[1] - floor.pose.hips.position[1])).toBeLessThan(.04);
  expect(floor.pose.left_ankle.position[2] - floor.pose.head.position[2]).toBeGreaterThan(1.4);
  expect(knees.pose.head.position[1] - floor.pose.head.position[1]).toBeGreaterThan(.8);
  await expect(page.locator(".motion-caption p")).toHaveText("ly down");
  await screenshot(page, testInfo, "lying-on-the-floor");
});

test("bow bends the torso and side kick extends laterally with the opposite foot planted", async ({ page }, testInfo) => {
  const bow = await direct(page, "bow", "action bow 1");
  expect(bow.loop).toBe(false);
  const bowDuration = compileMotion(bow.program).duration;
  const upright = await sample(page, 0, true), bowed = await sample(page, bowDuration * .5, true);
  expect(bowed.pose.head.position[2] - upright.pose.head.position[2]).toBeGreaterThan(.3);
  expect(upright.pose.head.position[1] - bowed.pose.head.position[1]).toBeGreaterThan(.2);
  await expect(page.locator(".motion-caption p")).toHaveText("bow");
  await screenshot(page, testInfo, "bow-forward");

  const kick = await direct(page, "side kick", "action side_kick_right 1");
  expect(kick.loop).toBe(false);
  const duration = compileMotion(kick.program).duration;
  const rest = await sample(page, 0, true), extended = await sample(page, duration * .5, true);
  expect(rest.pose.right_ankle.position[0] - extended.pose.right_ankle.position[0]).toBeGreaterThan(.6);
  expect(extended.pose.right_ankle.position[1] - rest.pose.right_ankle.position[1]).toBeGreaterThan(.4);
  expect(Math.abs(extended.pose.right_ankle.position[2] - rest.pose.right_ankle.position[2])).toBeLessThan(.002);
  expect(distance(extended.pose.left_ankle.position, rest.pose.left_ankle.position)).toBeLessThan(.002);
  await expect(page.locator(".motion-caption p")).toHaveText("side kick");
  await screenshot(page, testInfo, "lateral-kick-planted-support");
  const finish = await sample(page, duration, true);
  for (const joint of legs) expect(distance(finish.pose[joint].position, rest.pose[joint].position)).toBeLessThan(1e-6);
});

test("returning to both feet changes support and stopping dancing becomes idle without freezing legs", async ({ page }, testInfo) => {
  const oneFoot = await direct(page, "Now on one foot.", "support left");
  expect(oneFoot.program.dance).toEqual({ style: "gangnam", support: "left" });
  expect(oneFoot.playing).toBe(true);
  expect(oneFoot.frozen).toEqual([]);
  const raised = await sample(page, .48 * 60 / oneFoot.program.bpm);
  expect(raised.pose.right_ankle.position[1] - raised.pose.left_ankle.position[1]).toBeGreaterThan(.3);

  const bothFeet = await direct(page, "Go back to standing on both feet.", "support both");
  expect(bothFeet.program.dance).toEqual({ style: "gangnam", support: "both" });
  expect(bothFeet.playing).toBe(true);
  expect(bothFeet.frozen).toEqual([]);
  for (const id of ["arms", "details", "torso.groove"])
    expect(findNode(bothFeet.program.root, id)).toEqual(findNode(oneFoot.program.root, id));
  const rightLift = await sample(page, .48 * 60 / bothFeet.program.bpm);
  const leftLift = await sample(page, 1.48 * 60 / bothFeet.program.bpm);
  expect(rightLift.pose.right_ankle.position[1] - rightLift.pose.left_ankle.position[1]).toBeGreaterThan(.12);
  expect(leftLift.pose.left_ankle.position[1] - leftLift.pose.right_ankle.position[1]).toBeGreaterThan(.12);
  await expect(page.locator(".motion-caption p")).toHaveText("Go back to standing on both feet.");
  await screenshot(page, testInfo, "both-feet-dancing-again");

  const idle = await direct(page, "Stop dancing.", "dance idle");
  expect(idle.program.dance).toBeUndefined();
  expect(idle.character).toBe("gangnam");
  expect(idle.frozen).toEqual([]);
  const duration = compileMotion(idle.program).duration;
  const first = await sample(page, duration * .1), later = await sample(page, duration * .6);
  for (const joint of [...legs, ...armJoints("left"), ...armJoints("right"), "hips", "head"]) {
    expect(distance(later.pose[joint].position, first.pose[joint].position), `${joint} stops dancing`).toBeLessThan(1e-6);
    expect(angle(later.pose[joint].quaternion, first.pose[joint].quaternion)).toBeLessThan(1e-5);
  }
  await expect(page.locator(".motion-caption p")).toHaveText("Stop dancing.");
  await screenshot(page, testInfo, "standing-idle-without-leg-freezes");
});
