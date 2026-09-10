import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { createGangnam } from "../src/motion/gangnam";
import { createDance, jointOffset, replaceArm } from "../src/motion/skills";
import { createBodySequence } from "../src/motion/bodyActions";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import type { Timeline } from "../src/motion/types";

let rig: MotionRig;
test.beforeAll(async () => {
  const bytes = await readFile(new URL("../public/assets/gangnam-character.glb", import.meta.url));
  const model = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
  rig = new MotionRig(model.scene, model.animations);
});
test.afterAll(() => rig?.props.dispose());
const pose = (timeline: Timeline, time: number) => {
  rig.apply(sampleTimeline(timeline, time));
  return rig.snapshot();
};
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));

test("Gangnam arm styles visibly replace the reins without changing the supporting leg or body phase", () => {
  const original = createGangnam({ support: "left" });
  const before = JSON.stringify(original);
  const originalTimeline = compileMotion(original);
  for (const style of ["robot", "still", "wave", "natural"]) {
    const edited = applyCommands(original, `arms ${style}`);
    const timeline = validateRigProgram(edited);
    expect(edited.dance).toEqual(original.dance);
    expect(timeline.duration).toBe(originalTimeline.duration);
    for (const branch of ["feet", "torso", "details"])
      expect(findNode(edited.root, branch)).toEqual(findNode(original.root, branch));
    const articulation: Record<string, Quaternion[]> = { left_shoulder: [], right_shoulder: [], left_elbow: [], right_elbow: [] };
    let visibleChange = 0;
    for (let frame = 0; frame <= 32; frame++) {
      const time = timeline.duration * frame / 32;
      const baseline = pose(originalTimeline, time);
      const changed = pose(timeline, time);
      for (const joint of ["hips", "head", "left_knee", "right_knee", "left_ankle", "right_ankle"])
        expect(distance(baseline[joint].position, changed[joint].position), `${style}: ${joint}`).toBeLessThan(1e-7);
      expect(changed.right_ankle.position[1] - changed.left_ankle.position[1]).toBeGreaterThan(0.34);
      visibleChange = Math.max(visibleChange, distance(baseline.left_wrist.position, changed.left_wrist.position),
        distance(baseline.right_wrist.position, changed.right_wrist.position));
      for (const joint of Object.keys(articulation))
        articulation[joint].push(rig.joints.get(joint)!.bone.quaternion.clone());
    }
    expect(visibleChange, style).toBeGreaterThan(0.2);
    for (const [joint, rotations] of Object.entries(articulation)) {
      const change = Math.max(...rotations.map((q) => q.angleTo(rotations[0])));
      if (style === "still") expect(change, joint).toBeLessThan(1e-6);
      else expect(change, `${style}: ${joint}`).toBeGreaterThan(style === "robot" ? 0.8 : 0.1);
    }
  }
  expect(JSON.stringify(original)).toBe(before);
});

test("a shoulder edit changes just that arm and survives both support switches", () => {
  const original = createGangnam();
  const edited = applyCommands(original, "joint left_shoulder z 40");
  const base = compileMotion(original), changed = compileMotion(edited);
  expect(findNode(edited.root, "arms")).toEqual(findNode(original.root, "arms"));
  let wristChange = 0;
  for (let frame = 0; frame <= 32; frame++) {
    const time = base.duration * frame / 32;
    const before = pose(base, time), after = pose(changed, time);
    for (const joint of ["head", "hips", "right_shoulder", "right_elbow", "right_wrist", "left_ankle", "right_ankle"])
      expect(distance(before[joint].position, after[joint].position), joint).toBeLessThan(1e-7);
    wristChange = Math.max(wristChange, distance(before.left_wrist.position, after.left_wrist.position));
  }
  expect(wristChange).toBeGreaterThan(0.15);
  for (const support of ["left", "right", "both"]) {
    const supported = applyCommands(edited, `support ${support}`);
    const unedited = applyCommands(original, `support ${support}`);
    expect(supported.dance?.support).toBe(support);
    for (const branch of ["arms", "details", "torso.groove"])
      expect(findNode(supported.root, branch)).toEqual(findNode(edited.root, branch));
    expect(findNode(supported.root, "detail.left_shoulder.z")).toBeDefined();
    const target = compileMotion(supported), neutral = compileMotion(unedited);
    const before = pose(neutral, 1.5), after = pose(target, 1.5);
    expect(distance(before.left_wrist.position, after.left_wrist.position)).toBeGreaterThan(0.05);
    for (const joint of ["left_ankle", "right_ankle"])
      expect(distance(before[joint].position, after[joint].position)).toBeLessThan(1e-7);
  }
});

test("robot and still arm edits survive support changes at the same dance phase", () => {
  const original = createGangnam({ support: "left" });
  for (const style of ["robot", "still"]) {
    const edited = applyCommands(original, `arms ${style}`);
    const switched = applyCommands(edited, "support other");
    expect(switched.dance?.support).toBe("right");
    for (const branch of ["arms", "details", "torso.groove"])
      expect(findNode(switched.root, branch)).toEqual(findNode(edited.root, branch));
    const before = compileMotion(edited), after = compileMotion(switched);
    for (const time of [0, 1.7, 3.8, 6.8]) {
      const arms = (timeline: Timeline) => sampleTimeline(timeline, time)
        .filter((p) => /_(shoulder|elbow|wrist)$/.test(p.target));
      expect(arms(after)).toEqual(arms(before));
      const actual = pose(after, time);
      expect(actual.left_ankle.position[1] - actual.right_ankle.position[1]).toBeGreaterThan(0.34);
    }
  }
});

test("single-arm styles replace the whole selected pose and its prior offsets while preserving the opposite arm and fingers", () => {
  const original = applyCommands(createGangnam({ support: "left" }),
    "joint left_shoulder z 90\njoint right_shoulder x -15\njoint left_index_1 z 20");
  const prior = JSON.stringify(original);
  for (const style of ["still", "robot", "wave", "natural"] as const) {
    const edited = applyCommands(original, `arm left ${style}`);
    const timeline = validateRigProgram(edited);
    const baseline = compileMotion(original);
    for (const branch of ["feet", "torso", "arms.right", "detail.right_shoulder.x", "detail.left_index_1.z"])
      expect(findNode(edited.root, branch)).toEqual(findNode(original.root, branch));
    let lowWrist = 0;
    for (const time of [0, 1.2, 3.5, 5.3, 7]) {
      const before = pose(baseline, time), after = pose(timeline, time);
      for (const joint of ["right_shoulder", "right_elbow", "right_wrist", "left_ankle", "right_ankle"])
        expect(distance(before[joint].position, after[joint].position), joint).toBeLessThan(1e-7);
      if (style === "still") {
        for (const joint of ["left_clavicle", "left_shoulder", "left_elbow", "left_wrist"])
          expect(rig.joints.get(joint)!.bone.quaternion.angleTo(rig.joints.get(joint)!.rotation)).toBeLessThan(1e-6);
        lowWrist = Math.max(lowWrist, after.left_shoulder.position[1] - after.left_wrist.position[1]);
      }
    }
    if (style === "still") expect(lowWrist).toBeGreaterThan(0.45);
    const switched = applyCommands(edited, "support right");
    expect(findNode(switched.root, "arms")).toEqual(findNode(edited.root, "arms"));
    expect(findNode(switched.root, "details")).toEqual(findNode(edited.root, "details"));
    const again = applyCommands(edited, `arm left ${style}`);
    expect(compileMotion(again).tracks.length).toBe(timeline.tracks.length);
  }
  expect(JSON.stringify(original)).toBe(prior);
  const bothStill = applyCommands(original, "arms still");
  pose(compileMotion(bothStill), 1);
  for (const side of ["left", "right"])
    expect(rig.joints.get(`${side}_shoulder`)!.bone.quaternion.angleTo(rig.joints.get(`${side}_shoulder`)!.rotation)).toBeLessThan(1e-6);
});

test("single-arm replacement keeps opposite waves and timed body phases intact", () => {
  const originals = [
    applyCommands(createGangnam(), "wave right"),
    createBodySequence([{ action: "walk", count: 1 }, { action: "bow", count: 1 }]),
    jointOffset(createDance("salsa"), "right_wrist", "x", 12),
  ];
  for (const original of originals) {
    const edited = replaceArm(original, "left", "still");
    const before = compileMotion(original), after = validateRigProgram(edited);
    expect(after.duration).toBe(before.duration);
    for (const time of [0, before.duration * 0.33, before.duration * 0.8, before.duration]) {
      const baseline = pose(before, time), result = pose(after, time);
      for (const joint of ["right_shoulder", "right_elbow", "right_wrist", "left_ankle", "right_ankle", "head"])
        expect(distance(baseline[joint].position, result[joint].position), joint).toBeLessThan(1e-7);
    }
  }
});
