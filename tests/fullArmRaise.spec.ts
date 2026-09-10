import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { createGangnam } from "../src/motion/gangnam";
import { MotionRig } from "../src/motion/rig";
import { createDance } from "../src/motion/skills";
import type { Timeline } from "../src/motion/types";

async function loadRig(assetName: string) {
  const bytes = await readFile(new URL(`../public/assets/${assetName}`, import.meta.url));
  // The pose test uses the shipped skeleton, without needing browser textures.
  const jsonLength = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  delete asset.images;
  delete asset.textures;
  delete asset.samplers;
  asset.materials = [];
  for (const mesh of asset.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  const serialized = Buffer.from(JSON.stringify(asset));
  const json = Buffer.concat([serialized, Buffer.alloc((4 - serialized.length % 4) % 4, 32)]);
  const binary = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const model = await new GLTFLoader().parseAsync(Uint8Array.from(Buffer.concat([header, json, binary])).buffer, "");
  return new MotionRig(model.scene, model.animations);
}

const position = (pose: ReturnType<MotionRig["snapshot"]>, id: string) => new Vector3().fromArray(pose[id].position);
const fullRaise = (side: "left" | "right") => `arm ${side} still\njoint ${side}_shoulder z ${side === "left" ? 180 : -180}`;

for (const asset of ["character.glb", "gangnam-character.glb"]) {
  test(`${asset}: full arm raises reach overhead with a straight elbow throughout the dance`, async () => {
    const rig = await loadRig(asset);
    const poseAt = (timeline: Timeline, time: number) => {
      rig.apply(sampleTimeline(timeline, time));
      return rig.snapshot();
    };
    try {
      for (const original of [createDance("idle"), createGangnam({ support: "left" })]) {
        const detailed = applyCommands(original, "joint left_shoulder x -35\njoint right_wrist y 22\nwiggle left_index_1 z 40\nwiggle right_index_1 z -40");
        const baseline = compileMotion(detailed);
        for (const side of ["left", "right"] as const) {
          const other = side === "left" ? "right" : "left";
          const raised = applyCommands(detailed, fullRaise(side));
          const timeline = validateRigProgram(raised);
          expect(timeline.duration).toBe(baseline.duration);
          expect(raised.dance).toEqual(detailed.dance);
          for (const branch of ["feet", "torso", `detail.${side}_index_1.z`, `detail.${other}_index_1.z`])
            expect(findNode(raised.root, branch)).toEqual(findNode(detailed.root, branch));
          for (let frame = 0; frame <= 32; frame++) {
            const time = baseline.duration * frame / 32;
            const before = poseAt(baseline, time), after = poseAt(timeline, time);
            const shoulder = position(after, `${side}_shoulder`);
            const elbow = position(after, `${side}_elbow`);
            const wrist = position(after, `${side}_wrist`);
            const upper = elbow.clone().sub(shoulder).normalize();
            const lower = wrist.clone().sub(elbow).normalize();
            expect(upper.dot(lower), `${side} arm remains straight`).toBeGreaterThan(0.995);
            expect(upper.y, `${side} upper arm points upward`).toBeGreaterThan(0.94);
            expect(wrist.y - position(after, "head").y, `${side} hand above the head`).toBeGreaterThan(0.23);
            for (const joint of ["hips", "head", "left_ankle", "right_ankle", `${other}_shoulder`, `${other}_elbow`, `${other}_wrist`])
              expect(position(before, joint).distanceTo(position(after, joint)), `${joint} retains its phase`).toBeLessThan(1e-7);
            for (const joint of [`${side}_index_1`, `${other}_index_1`])
              expect(after[joint].quaternion).toEqual(before[joint].quaternion);
          }
        }
      }
    } finally {
      rig.props.dispose();
    }
  });

  test(`${asset}: both overhead reaches survive support changes, while a numeric 45-degree raise remains a joint edit`, async () => {
    const rig = await loadRig(asset);
    const poseAt = (timeline: Timeline, time: number) => {
      rig.apply(sampleTimeline(timeline, time));
      return rig.snapshot();
    };
    try {
      const original = createGangnam();
      const raised = applyCommands(original, `${fullRaise("left")}\n${fullRaise("right")}`);
      for (const support of ["left", "right", "both"]) {
        const supported = applyCommands(raised, `support ${support}`);
        const baseline = compileMotion(applyCommands(original, `support ${support}`));
        const timeline = compileMotion(supported);
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
          const time = timeline.duration * fraction;
          const before = poseAt(baseline, time), after = poseAt(timeline, time);
          for (const side of ["left", "right"]) {
            const upper = position(after, `${side}_elbow`).sub(position(after, `${side}_shoulder`)).normalize();
            const lower = position(after, `${side}_wrist`).sub(position(after, `${side}_elbow`)).normalize();
            expect(upper.dot(lower)).toBeGreaterThan(0.995);
            expect(position(after, `${side}_wrist`).y - position(after, "head").y).toBeGreaterThan(0.23);
            expect(after[`${side}_ankle`]).toEqual(before[`${side}_ankle`]);
          }
        }
      }
      for (const side of ["left", "right"] as const) {
        const numeric = applyCommands(original, `joint ${side}_shoulder z ${side === "left" ? 45 : -45}`);
        expect(findNode(numeric.root, "arms")).toEqual(findNode(original.root, "arms"));
        expect(findNode(numeric.root, `arms.edit.${side}`)).toBeUndefined();
        const baseline = compileMotion(original), changed = compileMotion(numeric);
        for (const time of [0, 1.2, 3.5, 5.3]) {
          const before = poseAt(baseline, time), after = poseAt(changed, time);
          expect(after[`${side}_elbow`].quaternion).toEqual(before[`${side}_elbow`].quaternion);
          expect(after[`${side}_wrist`].quaternion).toEqual(before[`${side}_wrist`].quaternion);
        }
      }
    } finally {
      rig.props.dispose();
    }
  });
}
