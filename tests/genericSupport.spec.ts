import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { createBodyAction } from "../src/motion/bodyActions";
import { createDexteritySequence } from "../src/motion/dexteritySequence";
import { compileMotion, findNode, sampleContacts, sampleTimeline } from "../src/motion/engine";
import { createGangnam, changeGangnamSupport } from "../src/motion/gangnam";
import { MotionRig } from "../src/motion/rig";
import { createDance, jointOffset } from "../src/motion/skills";
import type { MotionProgram, Timeline } from "../src/motion/types";

async function loadRig(assetName: string) {
  const bytes = await readFile(new URL(`../public/assets/${assetName}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  delete asset.images; delete asset.textures; delete asset.samplers; asset.materials = [];
  for (const mesh of asset.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const serialized = Buffer.from(JSON.stringify(asset));
  const json = Buffer.concat([serialized, Buffer.alloc((4 - serialized.length % 4) % 4, 32)]);
  const binary = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const model = await new GLTFLoader().parseAsync(Uint8Array.from(Buffer.concat([header, json, binary])).buffer, "");
  return new MotionRig(model.scene, model.animations);
}

const position = (pose: ReturnType<MotionRig["snapshot"]>, id: string) => new Vector3().fromArray(pose[id].position);
const upper = (timeline: Timeline) => timeline.tracks.filter(track => /^(left|right)_(clavicle|shoulder|elbow|wrist|thumb|index|middle|ring|pinky)(_|$)/.test(track.target))
  .map(({ ancestors: _ancestors, ...track }) => track);
const programs = (): MotionProgram[] => [
  createDance("idle"), createDance("salsa"), createDance("cha_cha"), createDance("robot"),
  createDexteritySequence().program, createBodyAction("run"), createBodyAction("lie_down"),
];

for (const asset of ["character.glb", "gangnam-character.glb"]) {
  test(`${asset}: generic support plants either foot without importing a dance or losing the hand showcase`, async () => {
    const rig = await loadRig(asset);
    const at = (timeline: Timeline, time: number) => {
      rig.apply(sampleTimeline(timeline, time), sampleContacts(timeline, time), timeline.props ?? []);
      return rig.snapshot();
    };
    try {
      rig.apply([]);
      const neutral = rig.snapshot();
      for (const original of programs()) {
        const serialized = JSON.stringify(original);
        const baseline = compileMotion(original);
        for (const side of ["left", "right"] as const) {
          const free = side === "left" ? "right" : "left";
          const supported = applyCommands(original, `support ${side}`);
          const timeline = validateRigProgram(supported);
          expect(supported.dance).toBeUndefined();
          expect(supported.props).toEqual(original.props);
          expect(timeline.duration).toBe(baseline.duration);
          expect(upper(timeline)).toEqual(upper(baseline));
          for (let frame = 0; frame <= 16; frame++) {
            const time = timeline.duration * frame / 16;
            const pose = at(timeline, time);
            expect(position(pose, `${side}_ankle`).distanceTo(position(neutral, `${side}_ankle`)), `${original.title}: ${side} ankle planted`).toBeLessThan(0.005);
            expect(position(pose, `${free}_ankle`).y - position(neutral, `${free}_ankle`).y, `${original.title}: ${free} ankle raised`).toBeGreaterThan(0.33);
            expect(sampleContacts(timeline, time)).toEqual(sampleContacts(baseline, time));
          }
          expect(applyCommands(supported, "support both")).toEqual(original);
          const switched = applyCommands(supported, "support other");
          const switchedPose = at(compileMotion(switched), timeline.duration * 0.37);
          expect(position(switchedPose, `${free}_ankle`).distanceTo(position(neutral, `${free}_ankle`))).toBeLessThan(0.005);
          expect(position(switchedPose, `${side}_ankle`).y - position(neutral, `${side}_ankle`).y).toBeGreaterThan(0.33);
        }
        expect(JSON.stringify(original)).toBe(serialized);
      }
    } finally { rig.props.dispose(); }
  });
}

test("later explicit joint edits remain effective while unrelated edits and speed changes retain support", () => {
  const original = createDexteritySequence().program;
  const supported = applyCommands(original, "support right");
  const edited = applyCommands(supported, "wiggle left_index_1 z 65\njoint head y 30\njoint left_knee x 25");
  expect(findNode(edited.root, "support_constraint.right")).toBeDefined();
  const changed = compileMotion(edited);
  expect(sampleTimeline(changed, changed.duration * 0.4).find(value => value.target === "left_knee" && value.axis === "x" && value.channel === "rotation")?.value).toBe(25);
  // The direct inspector uses jointOffset too, rather than the command parser.
  const slider = jointOffset(supported, "right_ankle", "x", 12);
  expect(sampleTimeline(compileMotion(slider), 1).find(value => value.target === "right_ankle" && value.axis === "x" && value.channel === "rotation")?.value).toBe(12);
  const faster = applyCommands(edited, "tempo_scale 1.25");
  expect(findNode(faster.root, "support_constraint.right")).toBeDefined();
  expect(applyCommands(faster, "support other").dance).toBeUndefined();
  const restored = applyCommands(faster, "support both");
  expect(findNode(restored.root, "support_constraint")).toBeUndefined();
  expect(sampleTimeline(compileMotion(restored), 1).find(value => value.target === "left_knee" && value.axis === "x" && value.channel === "rotation")?.value).toBe(25);
});

test("generic ordered support changes resolve held foot positions and preserve explicit Gangnam behavior", () => {
  const initial = createDance("idle");
  const raw = JSON.stringify({ kind: "sequence", steps: [
    { instruction: "Lift the left leg", commands: "support right", mode: "perform", seconds: 2 },
    { instruction: "Switch feet", commands: "support other", mode: "perform", seconds: 2 },
    { instruction: "Put both feet down", commands: "support both", mode: "perform", seconds: 2 },
  ] });
  const ordered = compileMotion(applyCommands(initial, raw));
  const height = (time: number, side: string) => sampleTimeline(ordered, time).find(value => value.target === `${side}_foot_ik` && value.axis === "y")?.value;
  expect(height(1, "left")).toBeCloseTo(0.34);
  expect(height(1, "right")).toBeCloseTo(0);
  expect(height(3, "left")).toBeCloseTo(0);
  expect(height(3, "right")).toBeCloseTo(0.34);
  expect(height(5, "left")).toBeCloseTo(0);
  expect(height(5, "right")).toBeCloseTo(0);
  const gangnam = applyCommands(createGangnam(), "arm left still\nwiggle right_index_1 z -30");
  for (const side of ["left", "right", "both", "other"] as const)
    expect(applyCommands(gangnam, `support ${side}`)).toEqual(changeGangnamSupport(gangnam, side));
});
