import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fingertip } from "../src/motion/contacts";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import {
  compileMotion,
  sampleContacts,
  sampleTimeline,
} from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { createDance } from "../src/motion/skills";
import type { Timeline } from "../src/motion/types";

// These are engine/rig tests, not evidence that a hosted language model has
// understood a prompt. They exercise the same validated commands it returns.
// Keep the published skeleton, geometry and animation; omit only texture loading.
async function loadRig() {
  const bytes = await readFile(
    new URL("../public/assets/character.glb", import.meta.url),
  );
  const length = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + length).toString());
  delete asset.images;
  delete asset.textures;
  delete asset.samplers;
  asset.materials = [];
  for (const mesh of asset.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  const serialized = Buffer.from(JSON.stringify(asset));
  const json = Buffer.concat([
    serialized,
    Buffer.alloc((4 - (serialized.length % 4)) % 4, 32),
  ]);
  const binary = bytes.subarray(20 + length),
    header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const gltf = await new GLTFLoader().parseAsync(
    Uint8Array.from(Buffer.concat([header, json, binary])).buffer,
    "",
  );
  return new MotionRig(gltf.scene, gltf.animations);
}

let rig: MotionRig;
test.beforeAll(async () => {
  rig = await loadRig();
});
test.afterAll(() => {
  rig?.props.dispose();
});
const vector = (values: number[]) =>
  new Vector3(...(values as [number, number, number]));
const quaternion = (values: number[]) =>
  new Quaternion(...(values as [number, number, number, number])).normalize();
function apply(timeline: Timeline, time: number) {
  rig.apply(
    sampleTimeline(timeline, time),
    sampleContacts(timeline, time),
    timeline.props,
  );
  return rig.snapshot();
}
function directed(commands: string, current = createDance("idle", "still")) {
  return applyCommands(current, commands);
}

test("each of the 30 finger joints can move in isolation on the published character", () => {
  const still = createDance("idle", "still"),
    baseline = compileMotion(still);
  for (const side of ["left", "right"] as const) {
    for (const finger of ["thumb", "index", "middle", "ring", "pinky"]) {
      for (const segment of [1, 2, 3]) {
        const target = `${side}_${finger}_${segment}`;
        const before = apply(baseline, 0);
        const beforeTip = fingertip(
          rig.joints,
          `${side}_${finger}_tip`,
        ).getWorldPosition(new Vector3());
        const after = apply(
          compileMotion(
            directed(`joint ${target} z ${side === "left" ? 65 : -65}`, still),
          ),
          0,
        );
        const afterTip = fingertip(
          rig.joints,
          `${side}_${finger}_tip`,
        ).getWorldPosition(new Vector3());
        expect(
          quaternion(before[target].quaternion).angleTo(
            quaternion(after[target].quaternion),
          ),
          target,
        ).toBeCloseTo((65 * Math.PI) / 180, 8);
        expect(
          beforeTip.distanceTo(afterTip),
          `${target} must visibly move its fingertip`,
        ).toBeGreaterThan(0.004);
        for (const [id, pose] of Object.entries(before)) {
          if (id === target) continue;
          expect(
            quaternion(pose.quaternion).angleTo(
              quaternion(after[id].quaternion),
            ),
            `${target} changed ${id}'s local rotation`,
          ).toBeLessThan(1e-7);
          // Descendants move with the selected joint; every other branch stays put.
          if (!id.startsWith(`${side}_${finger}_`))
            expect(
              vector(pose.position).distanceTo(vector(after[id].position)),
              `${target} displaced ${id}`,
            ).toBeLessThan(1e-9);
        }
      }
    }
  }
});

test("left and right leg lifts survive planted-foot IK, and lowering returns exactly to the original pose", () => {
  const neutral = createDance("idle", "still"),
    baseline = compileMotion(neutral);
  for (const side of ["left", "right"]) {
    const other = side === "left" ? "right" : "left";
    const before = apply(baseline, 1);
    const liftedProgram = directed(`joint ${side}_hip x -45`, neutral);
    const lifted = apply(compileMotion(liftedProgram), 1);
    expect(
      lifted[`${side}_ankle`].position[1] - before[`${side}_ankle`].position[1],
    ).toBeGreaterThan(0.15);
    expect(
      lifted[`${side}_ankle`].position[2] - before[`${side}_ankle`].position[2],
    ).toBeGreaterThan(0.35);
    for (const id of [
      "hips",
      `${other}_hip`,
      `${other}_knee`,
      `${other}_ankle`,
    ])
      expect(lifted[id], `lifting ${side} must preserve ${id}`).toEqual(
        before[id],
      );
    const lowered = apply(
      compileMotion(directed(`joint ${side}_hip x 0`, liftedProgram)),
      1,
    );
    for (const [id, pose] of Object.entries(before)) {
      expect(
        vector(lowered[id].position).distanceTo(vector(pose.position)),
      ).toBeLessThan(1e-9);
      expect(
        quaternion(lowered[id].quaternion).angleTo(quaternion(pose.quaternion)),
      ).toBeLessThan(1e-7);
    }
    const knee = apply(
      compileMotion(directed(`joint ${side}_knee x 65`, neutral)),
      1,
    );
    expect(
      quaternion(knee[`${side}_knee`].quaternion).angleTo(
        quaternion(before[`${side}_knee`].quaternion),
      ),
    ).toBeCloseTo((65 * Math.PI) / 180, 8);
    expect(
      vector(knee[`${side}_ankle`].position).distanceTo(
        vector(before[`${side}_ankle`].position),
      ),
    ).toBeGreaterThan(0.2);
  }
});

test("switching coin hands and replacing a trick releases every stale contact and prop", () => {
  let program = createDance("idle", "still");
  const originalPose = apply(compileMotion(program), 0);
  for (const [command, hand, contactMode] of [
    ["skill coin_roll left forward", "left", "prop_transfer"],
    ["skill coin_roll right reverse", "right", "prop_transfer"],
    ["skill finger_touches left reverse", "left", "fingertips"],
    ["skill finger_ripple right forward", "right", null],
  ] as const) {
    program = directed(command, program);
    const timeline = validateRigProgram(program);
    for (const fraction of [0.061, 0.297, 0.551, 0.817, 0.999]) {
      const time = timeline.duration * fraction,
        contacts = sampleContacts(timeline, time);
      apply(timeline, time);
      expect(contacts).toHaveLength(contactMode ? 1 : 0);
      if (contactMode) {
        const contact = contacts[0];
        expect(contact.mode).toBe(contactMode);
        const anchors =
          contact.mode === "prop_transfer"
            ? [contact.from, contact.to]
            : [contact.effector, contact.target];
        expect(anchors.every((anchor) => anchor.startsWith(hand + "_"))).toBe(
          true,
        );
      }
      const props = rig.props.snapshot();
      if (contactMode === "prop_transfer") {
        expect(Object.keys(props)).toEqual(["coin"]);
        expect(props.coin.visible).toBe(true);
        const wrist = rig.joints
          .get(`${hand}_wrist`)!
          .bone.getWorldPosition(new Vector3());
        expect(vector(props.coin.position).distanceTo(wrist)).toBeLessThan(
          0.22,
        );
      } else expect(props).toEqual({});
    }
    // Out-of-order scrubbing must be deterministic after a side/skill change.
    const remembered = apply(timeline, timeline.duration * 0.297);
    apply(timeline, timeline.duration * 0.999);
    expect(apply(timeline, timeline.duration * 0.297)).toEqual(remembered);
  }
  expect(apply(compileMotion(createDance("idle", "still")), 0)).toEqual(
    originalPose,
  );
  expect(rig.props.snapshot()).toEqual({});
});

test("coin reversal starts at the opposite knuckle and stays attached through very slow and fast playback", () => {
  for (const hand of ["left", "right"]) {
    for (const direction of ["forward", "reverse"]) {
      const original = directed(`skill coin_roll ${hand} ${direction}`);
      const timeline = compileMotion(original);
      const first = sampleContacts(timeline, 0)[0];
      expect(first.mode).toBe("prop_transfer");
      if (first.mode !== "prop_transfer")
        throw new Error("Expected a coin transfer");
      expect(first.from).toBe(
        `${hand}_${direction === "forward" ? "index" : "pinky"}_2`,
      );
      expect(first.to).toBe(
        `${hand}_${direction === "forward" ? "middle" : "ring"}_2`,
      );
      for (const bpm of [30, 240]) {
        const retimed = compileMotion(directed(`tempo ${bpm}`, original));
        expect(retimed.duration / timeline.duration).toBeCloseTo(
          original.bpm / bpm,
          8,
        );
        for (let index = 0; index <= 36; index++) {
          const fraction = index / 36;
          apply(timeline, timeline.duration * fraction);
          const normalCoin = rig.props.snapshot().coin;
          const normalHand = rig.snapshot();
          const spedHand = apply(retimed, retimed.duration * fraction);
          const spedCoin = rig.props.snapshot().coin;
          expect(spedCoin.visible).toBe(true);
          expect(
            vector(spedCoin.position).distanceTo(vector(normalCoin.position)),
          ).toBeLessThan(1e-8);
          expect(
            quaternion(spedCoin.quaternion).angleTo(
              quaternion(normalCoin.quaternion),
            ),
          ).toBeLessThan(1e-7);
          for (const finger of ["index", "middle", "ring", "pinky"])
            expect(
              vector(spedHand[`${hand}_${finger}_2`].position).distanceTo(
                vector(normalHand[`${hand}_${finger}_2`].position),
              ),
            ).toBeLessThan(1e-8);
        }
      }
    }
  }
});

test("salsa keeps every body joint moving identically while one finger wiggles, including after a tempo edit", () => {
  const dance = createDance("salsa"),
    baseline = compileMotion(dance);
  for (const hand of ["left", "right"]) {
    for (const finger of ["thumb", "index"]) {
      const targets = [1, 2, 3].map(
        (segment) => `${hand}_${finger}_${segment}`,
      );
      const edited = directed(
        targets
          .map((target) => `wiggle ${target} z ${hand === "left" ? 65 : -65}`)
          .join("\n"),
        dance,
      );
      for (const bpm of [72, 180]) {
        const timeline = compileMotion(directed(`tempo ${bpm}`, edited));
        let maximumFingerMovement = 0;
        for (const fraction of [0, 0.061, 0.125, 0.283, 0.417, 0.731, 0.937]) {
          const before = apply(baseline, baseline.duration * fraction);
          const after = apply(timeline, timeline.duration * fraction);
          for (const [id, pose] of Object.entries(before)) {
            if (targets.includes(id)) {
              maximumFingerMovement = Math.max(
                maximumFingerMovement,
                quaternion(pose.quaternion).angleTo(
                  quaternion(after[id].quaternion),
                ),
              );
              continue;
            }
            expect(
              vector(pose.position).distanceTo(vector(after[id].position)),
              `${hand} ${finger} at ${bpm} bpm displaced ${id}`,
            ).toBeLessThan(1e-8);
            expect(
              quaternion(pose.quaternion).angleTo(
                quaternion(after[id].quaternion),
              ),
              `${hand} ${finger} at ${bpm} bpm rotated ${id}`,
            ).toBeLessThan(1e-7);
          }
        }
        expect(maximumFingerMovement).toBeGreaterThan(1);
      }
    }
  }
});

test("slowing the current hand trick keeps its close-up and replay uses the retimed creation", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.routeWebSocket("**", () => {});
  await page.route("**/api/direct", (route) =>
    route.fulfill({ json: { output: "tempo 54" } }),
  );
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(
    () => !!(window as any).__motion && !!(window as any).__motionStudio,
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    (window as any).__motionStudio.seek(13.4);
    (window as any).__motion.seek(13.4);
  });
  const before = await page.evaluate(() => ({
    studio: (window as any).__motionStudio.snapshot(),
    camera: (window as any).__motion.cameraSnapshot(),
  }));
  expect(before.camera.focus).toBe("left_hand");
  await page.getByLabel("Direction", { exact: true }).fill("Slow it down");
  await page
    .getByRole("button", { name: "Apply direction", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__motionStudio.snapshot().program.bpm,
      ),
    )
    .toBe(54);
  const after = await page.evaluate(() => ({
    studio: (window as any).__motionStudio.snapshot(),
    camera: (window as any).__motion.cameraSnapshot(),
  }));
  await page.screenshot({
    path: testInfo.outputPath("tempo-hand-framing.png"),
    fullPage: true,
  });
  expect(
    after.camera.focus,
    "A speed-only edit must retain the hand close-up",
  ).toBe("left_hand");
  const original = compileMotion(before.studio.program),
    retimed = compileMotion(after.studio.program);
  expect(retimed.duration / original.duration).toBeCloseTo(
    before.studio.program.bpm / 54,
    8,
  );
  expect(
    Math.abs(
      after.studio.time / retimed.duration -
        before.studio.time / original.duration,
    ),
    "Changing speed keeps the current point in the gesture",
  ).toBeLessThan(0.04);
  expect(after.studio.playing).toBe(true);
  expect(after.studio.program.props).toEqual(before.studio.program.props);
  await page
    .getByRole("button", { name: "Replay current motion", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => (window as any).__motionStudio.snapshot().program,
    ),
  ).toEqual(after.studio.program);
  expect(
    await page.evaluate(() => (window as any).__motion.cameraSnapshot().focus),
  ).toBe("left_hand");
  expect(errors).toEqual([]);
});
