import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createBodyAction, createBodySequence } from "../src/motion/bodyActions";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { createDance } from "../src/motion/skills";
import type { Timeline } from "../src/motion/types";

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

for (const asset of ["character.glb", "gangnam-character.glb"]) {
  test(`${asset}: a sway travels in both directions with planted feet and relaxed arms`, async () => {
    const rig = await loadRig(asset);
    const at = (timeline: Timeline, time: number) => { rig.apply(sampleTimeline(timeline, time)); return rig.snapshot(); };
    try {
      const original = createBodyAction("sway");
      const timeline = validateRigProgram(original);
      expect(timeline.duration).toBeCloseTo(240 / original.bpm);
      expect(original.dance).toBeUndefined();
      expect(timeline.tracks.filter(track => track.ancestors.includes("arms")).every(track => track.curve.kind === "constant")).toBe(true);
      const rest = at(timeline, 0), left = at(timeline, timeline.duration * .25), right = at(timeline, timeline.duration * .75);
      expect(left.hips.position[0] - rest.hips.position[0]).toBeGreaterThan(.08);
      expect(rest.hips.position[0] - right.hips.position[0]).toBeGreaterThan(.08);
      expect(left.head.position[0] - rest.head.position[0]).toBeGreaterThan(.13);
      expect(rest.head.position[0] - right.head.position[0]).toBeGreaterThan(.13);
      for (let frame = 0; frame <= 64; frame++) {
        const pose = at(timeline, timeline.duration * frame / 64);
        for (const side of ["left", "right"]) {
          expect(position(pose, `${side}_ankle`).distanceTo(position(rest, `${side}_ankle`)), `${side} foot stays planted`).toBeLessThan(.002);
          expect(pose[`${side}_knee`].position[1]).toBeGreaterThan(.4);
          expect(position(pose, `${side}_wrist`).y).toBeLessThan(position(pose, `${side}_shoulder`).y - .3);
        }
      }
      const finish = at(timeline, timeline.duration);
      for (const id of Object.keys(rest)) expect(position(finish, id).distanceTo(position(rest, id))).toBeLessThan(1e-7);
      const reversed = compileMotion(applyCommands(original, "reverse current"));
      expect(at(reversed, reversed.duration * .25).hips.position[0]).toBeCloseTo(right.hips.position[0]);
      const still = compileMotion(applyCommands(original, "arms still"));
      for (const fraction of [0, .25, .5, .75, 1]) {
        const baseline = at(timeline, timeline.duration * fraction), quiet = at(still, still.duration * fraction);
        for (const part of ["hips", "left_knee", "right_knee", "left_ankle", "right_ankle"])
          expect(position(quiet, part).distanceTo(position(baseline, part))).toBeLessThan(1e-7);
      }
    } finally { rig.props.dispose(); }
  });
}

test("sways repeat complete cycles, compose with other actions, and retain editable body curves", () => {
  for (let count = 1; count <= 8; count++) {
    const program = applyCommands(createDance("idle"), `action sway ${count}`);
    const timeline = validateRigProgram(program);
    const cycle = 240 / program.bpm;
    expect(timeline.duration).toBeCloseTo(cycle * count);
    expect(findNode(program.root, "torso.sway")).toBeDefined();
    for (let repetition = 0; repetition < count; repetition++) {
      const rootX = (fraction: number) => sampleTimeline(timeline, cycle * (repetition + fraction))
        .find(value => value.target === "root" && value.channel === "position" && value.axis === "x")?.value;
      expect(rootX(.25)).toBeCloseTo(.085);
      expect(rootX(.75)).toBeCloseTo(-.085);
      expect(rootX(1)).toBeCloseTo(0);
    }
  }
  const ordered = createBodySequence([{ action: "sway", count: 2 }, { action: "bow", count: 1 }]);
  expect(findNode(ordered.root, "body_step.0.torso.sway")).toBeDefined();
  expect(findNode(ordered.root, "body_step.1.torso.hinge")).toBeDefined();
  expect(compileMotion(ordered).duration).toBeCloseTo(240 / ordered.bpm * 3 + .28);
  const edited = applyCommands(createBodyAction("sway"), "wiggle left_index_1 z 65");
  expect(findNode(edited.root, "torso")).toEqual(findNode(createBodyAction("sway").root, "torso"));
  expect(() => applyCommands(createDance("idle"), "action sway 1 left")).toThrow("invalid body action");
});
