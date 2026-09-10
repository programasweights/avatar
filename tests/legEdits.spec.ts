import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { createGangnam } from "../src/motion/gangnam";
import { createBodySequence } from "../src/motion/bodyActions";
import { compileMotion, sampleTimeline } from "../src/motion/engine";
import { armTargets, freezeTargets, freezeTargetGroups, legTargets, resolveEditTarget, restoreFrozen } from "../src/motion/editing";
import { MotionRig } from "../src/motion/rig";
import type { MotionProgram, Timeline } from "../src/motion/types";

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
const angle = (a: number[], b: number[]) => new Quaternion().fromArray(a).normalize()
  .angleTo(new Quaternion().fromArray(b).normalize());

test("whole-leg targets keep IK groups together and distinguish a leg from its individual joints", () => {
  expect(resolveEditTarget("left_leg", "right", [])).toEqual(legTargets("left"));
  expect(resolveEditTarget("right_leg", "left", [])).toEqual(legTargets("right"));
  expect(resolveEditTarget("both_legs", "left", [])).toEqual(legTargets());
  expect(resolveEditTarget("legs", "left", [])).toEqual(legTargets());
  expect(resolveEditTarget("leg", "right", [])).toEqual(legTargets("right"));
  expect(freezeTargetGroups([...legTargets(), "left_elbow", "head"])).toEqual([
    legTargets("left"), legTargets("right"), ["left_elbow"], ["head"],
  ]);
  expect(resolveEditTarget("left_knee", "right", [])).toEqual(["left_knee"]);
});

test("leg pauses hold the actual hips, knees and feet while arms retain their dance phase", () => {
  const programs: MotionProgram[] = [
    createGangnam(), createGangnam({ support: "left" }), createGangnam({ support: "right" }),
    applyCommands(createGangnam(), "joint left_knee x 12\nwiggle right_ankle x 8"),
    createBodySequence([{ action: "run", count: 1 }]),
  ];
  for (const original of programs) {
    const timeline = compileMotion(original);
    const pauseTime = timeline.duration * 0.217;
    for (const target of ["left_leg", "right_leg", "both_legs"]) {
      const targets = resolveEditTarget(target, "left", []);
      const held = pose(timeline, pauseTime);
      const frozen = freezeTargets(original, targets, pauseTime);
      const changed = validateRigProgram(frozen.program);
      expect(changed.duration).toBe(timeline.duration);
      expect(frozen.program.dance).toEqual(original.dance);
      let armMovement = 0, oppositeMovement = 0;
      const first = pose(changed, 0);
      for (let frame = 0; frame <= 36; frame++) {
        const time = timeline.duration * frame / 36;
        const baseline = pose(timeline, time);
        const current = pose(changed, time);
        for (const joint of [...targets, "hips"]) {
          expect(distance(current[joint].position, held[joint].position), `${original.title}: ${target} ${joint} position`).toBeLessThan(1e-7);
          expect(angle(current[joint].quaternion, held[joint].quaternion), `${target} ${joint} rotation`).toBeLessThan(1e-6);
        }
        for (const joint of [...armTargets(), "spine", "spine_mid", "chest", "head"])
          expect(angle(current[joint].quaternion, baseline[joint].quaternion), `${target}: ${joint} phase`).toBeLessThan(1e-6);
        armMovement = Math.max(armMovement, angle(current.left_elbow.quaternion, first.left_elbow.quaternion),
          angle(current.right_shoulder.quaternion, first.right_shoulder.quaternion));
        const opposite = target === "left_leg" ? "right_ankle" : "left_ankle";
        oppositeMovement = Math.max(oppositeMovement, distance(current[opposite].position, first[opposite].position));
      }
      expect(armMovement, `${original.title}: arms keep moving`).toBeGreaterThan(0.1);
      if (target !== "both_legs") expect(oppositeMovement, `${original.title}: opposite foot keeps moving`).toBeGreaterThan(0.005);
      expect(restoreFrozen(frozen.program, frozen.token)).toEqual(original);
    }
  }
});

test("shared base remains held until both leg pauses are released and restoration is exact", () => {
  const original = createGangnam();
  const left = freezeTargets(original, legTargets("left"), 0.73);
  const right = freezeTargets(left.program, legTargets("right"), 1.48);
  const both = compileMotion(right.program);
  const heldRight = pose(both, 0);
  const leftRestored = restoreFrozen(right.program, left.token);
  const changed = compileMotion(leftRestored);
  let leftMovement = 0;
  for (let frame = 0; frame <= 24; frame++) {
    const current = pose(changed, changed.duration * frame / 24);
    for (const joint of [...legTargets("right"), "hips"])
      expect(distance(current[joint].position, heldRight[joint].position), joint).toBeLessThan(1e-7);
    leftMovement = Math.max(leftMovement, distance(current.left_ankle.position, heldRight.left_ankle.position));
  }
  expect(leftMovement).toBeGreaterThan(0.05);
  expect(restoreFrozen(leftRestored, right.token)).toEqual(original);
  expect(restoreFrozen(restoreFrozen(right.program, right.token), left.token)).toEqual(original);
});

test("leg pauses retain the sampled FK or IK solver across mixed posture and running phases", () => {
  const original = createBodySequence([{ action: "lie_down", count: 1 }, { action: "run", count: 1 }]);
  const timeline = compileMotion(original);
  for (const pauseTime of [1.8, timeline.duration - 0.6]) {
    for (const target of ["left_leg", "both_legs"]) {
      const targets = resolveEditTarget(target, "left", []);
      const held = pose(timeline, pauseTime);
      const frozen = freezeTargets(original, targets, pauseTime);
      const changed = validateRigProgram(frozen.program);
      for (let frame = 0; frame <= 40; frame++) {
        const current = pose(changed, changed.duration * frame / 40);
        for (const joint of [...targets, "hips"]) {
          expect(distance(current[joint].position, held[joint].position), `${target}: ${joint}`).toBeLessThan(1e-7);
          expect(angle(current[joint].quaternion, held[joint].quaternion), `${target}: ${joint}`).toBeLessThan(1e-6);
        }
      }
      const reversed = validateRigProgram(applyCommands(frozen.program, "reverse current\ntempo_scale 1.25"));
      for (const time of [0, 0.4, reversed.duration * 0.6, reversed.duration]) {
        const current = pose(reversed, time);
        for (const joint of targets)
          expect(distance(current[joint].position, held[joint].position), `${target}: ${joint} after reverse/speed`).toBeLessThan(1e-7);
      }
      expect(restoreFrozen(frozen.program, frozen.token)).toEqual(original);
    }
  }
});
