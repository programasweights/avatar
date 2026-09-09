import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  createBodyAction,
  createBodySequence,
} from "../src/motion/bodyActions";
import { applyCommands } from "../src/motion/director";
import { compileMotion, sampleTimeline } from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { createDance } from "../src/motion/skills";
import type { Timeline } from "../src/motion/types";

async function loadActualRig(): Promise<MotionRig> {
  const bytes = await readFile(
    new URL("../public/assets/character.glb", import.meta.url),
  );
  const jsonLength = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
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
  const binary = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const packed = Uint8Array.from(Buffer.concat([header, json, binary])).buffer;
  const gltf = await new GLTFLoader().parseAsync(packed, "");
  return new MotionRig(gltf.scene, gltf.animations);
}

let rig: MotionRig;
test.beforeAll(async () => {
  rig = await loadActualRig();
});
test.afterAll(() => rig?.props.dispose());

function poseAt(timeline: Timeline, time: number) {
  rig.apply(sampleTimeline(timeline, time));
  return rig.snapshot();
}

const distance = (a: number[], b: number[]) =>
  new Vector3(...(a as [number, number, number])).distanceTo(
    new Vector3(...(b as [number, number, number])),
  );

test("support parameters are explicit, jump-only, and preserve the existing two-foot motion", () => {
  const current = createDance("idle");
  expect(applyCommands(current, "action jump 2 both")).toEqual(
    applyCommands(current, "action jump 2"),
  );
  for (const invalid of [
    "action run 1 left",
    "action kick_left 1 right",
    "action bow 1 both",
    "action jump 1 other",
    "action jump 1 left extra",
    "action jump 0 left",
  ])
    expect(() => applyCommands(current, invalid), invalid).toThrow();
  expect(() => createBodyAction("run", 1, 108, "left")).toThrow();
});

test("left and right single-foot hops keep the other foot raised through every takeoff and landing", () => {
  for (const support of ["left", "right"] as const) {
    const free = support === "left" ? "right" : "left";
    for (const count of [1, 3, 8]) {
      const timeline = compileMotion(
        createBodyAction("jump", count, 108, support),
      );
      const rest = poseAt(timeline, 0);
      const phrase = timeline.duration / count;
      let airborne = false;
      let takeoffs = 0;
      let maximumLift = 0;
      for (let frame = 0; frame <= 120 * count; frame++) {
        const time = (timeline.duration * frame) / (120 * count);
        const pose = poseAt(timeline, time);
        const lift =
          pose[`${support}_ankle`].position[1] -
          rest[`${support}_ankle`].position[1];
        maximumLift = Math.max(maximumLift, lift);
        if (lift > 0.08 && !airborne) {
          takeoffs++;
          airborne = true;
        }
        if (lift < 0.02) airborne = false;
        expect(
          lift,
          `${support} support must not enter the floor`,
        ).toBeGreaterThanOrEqual(-0.001);
        if (time >= phrase * 0.18 && time <= timeline.duration - phrase * 0.16)
          expect(
            pose[`${free}_ankle`].position[1] -
              rest[`${free}_ankle`].position[1],
            `${free} foot must stay tucked, including between hops`,
          ).toBeGreaterThan(0.22);
      }
      expect(takeoffs, `${count} ${support}-foot takeoffs`).toBe(count);
      expect(maximumLift).toBeGreaterThan(0.32);
      const recovered = poseAt(timeline, timeline.duration);
      for (const target of Object.keys(rest))
        expect(
          distance(rest[target].position, recovered[target].position),
          target,
        ).toBeLessThan(1e-6);
    }
  }
});

test("single-foot hops mirror their actual feet and shift the body over the chosen support", () => {
  const left = compileMotion(createBodyAction("jump", 2, 108, "left"));
  const right = compileMotion(createBodyAction("jump", 2, 108, "right"));
  const neutral = poseAt(left, 0);
  for (const progress of [0.08, 0.2, 0.35, 0.5, 0.7, 0.88]) {
    const l = poseAt(left, left.duration * progress);
    const r = poseAt(right, right.duration * progress);
    expect(l.hips.position[0] - neutral.hips.position[0]).toBeGreaterThan(0.07);
    expect(r.hips.position[0] - neutral.hips.position[0]).toBeLessThan(-0.07);
    for (const joint of ["ankle", "knee"])
      for (const axis of [0, 1, 2]) {
        const leftDelta =
          l[`left_${joint}`].position[axis] -
          neutral[`left_${joint}`].position[axis];
        const rightDelta =
          r[`right_${joint}`].position[axis] -
          neutral[`right_${joint}`].position[axis];
        expect(leftDelta).toBeCloseTo(rightDelta * (axis === 0 ? -1 : 1), 3);
      }
  }
});

test("ordered actions retain each jump's support and repetition count", () => {
  const sequence = compileMotion(
    createBodySequence([
      { action: "jump", count: 2, support: "left" },
      { action: "jump", count: 3, support: "right" },
      { action: "bow", count: 1 },
    ]),
  );
  const left = compileMotion(createBodyAction("jump", 2, 108, "left"));
  const right = compileMotion(createBodyAction("jump", 3, 108, "right"));
  for (const [timeline, start] of [
    [left, 0],
    [right, left.duration + 0.28],
  ] as const)
    for (const progress of [0.2, 0.44, 0.64, 0.82]) {
      const isolated = poseAt(timeline, timeline.duration * progress);
      const composed = poseAt(sequence, start + timeline.duration * progress);
      for (const target of [
        "left_ankle",
        "right_ankle",
        "left_knee",
        "right_knee",
        "hips",
      ])
        expect(
          distance(isolated[target].position, composed[target].position),
          target,
        ).toBeLessThan(1e-6);
    }
});

test("arms still removes arm articulation while preserving kick, jump and run sequence footwork", () => {
  const commands = "action kick_left 1\naction jump 2 left\naction run 1";
  const current = createDance("idle");
  const original = compileMotion(applyCommands(current, commands));
  const constrained = compileMotion(
    applyCommands(current, `${commands}\narms still`),
  );
  const arms = ["left", "right"].flatMap((side) =>
    ["clavicle", "shoulder", "elbow", "wrist"].map(
      (joint) => `${side}_${joint}`,
    ),
  );
  poseAt(constrained, 0);
  const armRest = new Map(
    arms.map((target) => [
      target,
      rig.joints.get(target)!.bone.quaternion.clone(),
    ]),
  );
  let originalArticulation = 0;
  for (let frame = 0; frame <= 120; frame++) {
    const time = (original.duration * frame) / 120;
    const normal = poseAt(original, time);
    originalArticulation = Math.max(
      originalArticulation,
      ...arms.map((target) =>
        armRest.get(target)!.angleTo(rig.joints.get(target)!.bone.quaternion),
      ),
    );
    const still = poseAt(constrained, time);
    for (const target of arms)
      expect(
        new Quaternion()
          .copy(rig.joints.get(target)!.bone.quaternion)
          .angleTo(armRest.get(target)!),
        target,
      ).toBeLessThan(1e-6);
    for (const target of [
      "hips",
      "left_hip",
      "right_hip",
      "left_knee",
      "right_knee",
      "left_ankle",
      "right_ankle",
    ])
      expect(
        distance(normal[target].position, still[target].position),
        target,
      ).toBeLessThan(1e-6);
  }
  expect(originalArticulation).toBeGreaterThan(0.5);
  expect(constrained.duration).toBe(original.duration);
});
