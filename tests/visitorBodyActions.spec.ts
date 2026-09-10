import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  createBodyAction,
  createBodySequence,
} from "../src/motion/bodyActions";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { compileMotion, sampleTimeline } from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { getOrderedSequenceCues } from "../src/motion/orderedSequence";
import { createDance } from "../src/motion/skills";
import type { Timeline } from "../src/motion/types";
import { sampleContacts } from "../src/motion/engine";

async function loadActualRig(assetName: string): Promise<MotionRig> {
  const bytes = await readFile(
    new URL(`../public/assets/${assetName}`, import.meta.url),
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
const rigs = new Map<string, MotionRig>();
test.beforeAll(async () => {
  for (const file of ["character.glb", "gangnam-character.glb"]) rigs.set(file, await loadActualRig(file));
});
test.afterAll(() => {
  for (const rig of rigs.values()) rig.props.dispose();
});

function apply(timeline: Timeline, time: number) {
  rig.apply(
    sampleTimeline(timeline, time),
    sampleContacts(timeline, time),
    timeline.props ?? [],
  );
}

const distance = (a: number[], b: number[]) =>
  new Vector3(...(a as [number, number, number])).distanceTo(
    new Vector3(...(b as [number, number, number])),
  );
const poseAt = (timeline: Timeline, time: number) => {
  apply(timeline, time);
  return rig.snapshot();
};

for (const character of ["character.glb", "gangnam-character.glb"]) {
  test(`${character}: kneeling grounds both knees, tucks the feet behind, and holds an upright torso`, () => {
    rig = rigs.get(character)!;
    const timeline = compileMotion(applyCommands(createDance("idle"), "action kneel 1"));
    const start = poseAt(timeline, 0), finish = poseAt(timeline, timeline.duration);
    const crouch = compileMotion(createBodyAction("crouch"));
    const crouched = poseAt(crouch, crouch.duration * .5);
    for (const side of ["left", "right"]) {
      expect(finish[`${side}_knee`].position[1]).toBeLessThan(.11);
      expect(finish[`${side}_knee`].position[1]).toBeGreaterThan(.04);
      expect(crouched[`${side}_knee`].position[1] - finish[`${side}_knee`].position[1]).toBeGreaterThan(.15);
      expect(finish[`${side}_knee`].position[2] - finish[`${side}_ankle`].position[2]).toBeGreaterThan(.4);
    }
    expect(start.hips.position[1] - finish.hips.position[1]).toBeGreaterThan(.45);
    expect(finish.head.position[1] - finish.hips.position[1]).toBeGreaterThan(.6);
    expect(Math.abs(finish.head.position[2] - finish.hips.position[2])).toBeLessThan(.1);
    expect(poseAt(timeline, timeline.duration * .75)).toEqual(finish);
    for (let frame = 0; frame <= 120; frame++) {
      const pose = poseAt(timeline, timeline.duration * frame / 120);
      for (const side of ["left", "right"])
        for (const part of ["ankle", "knee"]) expect(pose[`${side}_${part}`].position[1]).toBeGreaterThan(.035);
    }
  });

  test(`${character}: repeated side kicks travel laterally with a planted support and keep still-arm constraints`, () => {
    rig = rigs.get(character)!;
    for (const side of ["left", "right"] as const) {
      const other = side === "left" ? "right" : "left", sign = side === "left" ? 1 : -1;
      const action = `side_kick_${side}` as const;
      const program = applyCommands(createDance("idle"), `action ${action} 2`);
      const timeline = compileMotion(program), rest = poseAt(timeline, 0);
      const still = compileMotion(applyCommands(program, "arms still"));
      let extended = false, kicks = 0;
      for (let frame = 0; frame <= 240; frame++) {
        const time = timeline.duration * frame / 240, pose = poseAt(timeline, time);
        const lateral = sign * (pose[`${side}_ankle`].position[0] - rest[`${side}_ankle`].position[0]);
        if (lateral > .6 && !extended) { kicks++; extended = true; }
        if (lateral < .1) extended = false;
        expect(Math.abs(pose[`${side}_ankle`].position[2] - rest[`${side}_ankle`].position[2])).toBeLessThan(.002);
        expect(distance(pose[`${other}_ankle`].position, rest[`${other}_ankle`].position)).toBeLessThan(.002);
        if (lateral > .6) expect(pose[`${side}_ankle`].position[1] - rest[`${side}_ankle`].position[1]).toBeGreaterThan(.4);
        const quiet = poseAt(still, time);
        for (const joint of ["left_hip", "left_knee", "left_ankle", "right_hip", "right_knee", "right_ankle"])
          expect(quiet[joint]).toEqual(pose[joint]);
      }
      expect(kicks).toBe(2);
      const finish = poseAt(timeline, timeline.duration);
      for (const joint of Object.keys(rest)) expect(distance(finish[joint].position, rest[joint].position)).toBeLessThan(1e-6);
    }
  });

  test(`${character}: lying down reclines onto the floor without sweeping either foot through it`, () => {
    rig = rigs.get(character)!;
    for (let count = 1; count <= 8; count++) {
      const program = applyCommands(createDance("idle"), `action lie_down ${count}`);
      const timeline = validateRigProgram(program);
      expect(timeline.duration).toBeCloseTo(4 * 60 / program.bpm * count, 8);
      for (const track of timeline.tracks)
        if (track.curve.kind === "keys") expect(track.curve.points.length).toBeLessThanOrEqual(81);
      const finish = poseAt(timeline, timeline.duration);
      expect(finish.head.position[1]).toBeGreaterThan(.1);
      expect(finish.head.position[1]).toBeLessThan(.2);
      expect(Math.abs(finish.head.position[1] - finish.hips.position[1])).toBeLessThan(.04);
      expect(finish.left_ankle.position[2] - finish.head.position[2]).toBeGreaterThan(1.4);
      expect(poseAt(timeline, timeline.duration * (1 - .1 / count))).toEqual(finish);
      let minimumAnkle = Infinity, maximumAnkle = -Infinity, minimumKnee = Infinity, minimumHips = Infinity;
      let finite = true;
      for (let frame = 0; frame <= 120 * count; frame++) {
        const pose = poseAt(timeline, timeline.duration * frame / (120 * count));
        for (const side of ["left", "right"]) {
          minimumAnkle = Math.min(minimumAnkle, pose[`${side}_ankle`].position[1]);
          maximumAnkle = Math.max(maximumAnkle, pose[`${side}_ankle`].position[1]);
          minimumKnee = Math.min(minimumKnee, pose[`${side}_knee`].position[1]);
        }
        minimumHips = Math.min(minimumHips, pose.hips.position[1]);
        finite &&= Object.values(pose).flatMap(joint => [...joint.position, ...joint.quaternion]).every(Number.isFinite);
      }
      expect(minimumAnkle, `${count} repetitions keep both feet above the floor`).toBeGreaterThan(.077);
      expect(maximumAnkle).toBeLessThan(.096);
      expect(minimumKnee).toBeGreaterThan(.1);
      expect(minimumHips).toBeGreaterThan(.1);
      expect(finite).toBe(true);
      const halfway = poseAt(timeline, timeline.duration * .35 / count);
      poseAt(timeline, timeline.duration);
      expect(poseAt(timeline, timeline.duration * .35 / count)).toEqual(halfway);
    }
  });
}

test("posture phases preserve a preceding turn and expose their distinct final poses in order", () => {
  rig = rigs.get("gangnam-character.glb")!;
  const sequence = compileMotion(createBodySequence([
    { action: "turn_left", count: 1 },
    { action: "kneel", count: 1 },
    { action: "lie_down", count: 1 },
  ]));
  const turn = compileMotion(createBodyAction("turn_left")), kneel = compileMotion(createBodyAction("kneel"));
  const knees = poseAt(sequence, turn.duration + .28 + kneel.duration * .8);
  expect(knees.head.position[1]).toBeGreaterThan(1);
  expect(knees.left_knee.position[1]).toBeLessThan(.11);
  const lying = poseAt(sequence, sequence.duration);
  expect(lying.head.position[1]).toBeLessThan(.2);
  expect(lying.left_ankle.position[1]).toBeGreaterThan(.075);
  expect(lying.right_ankle.position[1]).toBeGreaterThan(.075);
  expect(lying.left_ankle.position[0] - lying.head.position[0]).toBeGreaterThan(1.4);
  expect(Math.abs(lying.left_ankle.position[2] - lying.head.position[2])).toBeLessThan(.15);
  // Boundary poses remain continuous when changing between FK and grounded IK.
  for (const boundary of [turn.duration, turn.duration + .28, turn.duration + .28 + kneel.duration, turn.duration + .56 + kneel.duration]) {
    const before = poseAt(sequence, boundary - 1e-7), after = poseAt(sequence, boundary + 1e-7);
    for (const joint of Object.keys(before)) expect(distance(before[joint].position, after[joint].position), `${joint} at ${boundary}`).toBeLessThan(.001);
  }
});

test("leaving a lie-down recovers above the floor before running or kneeling in both sequence forms", () => {
  rig = rigs.get("gangnam-character.glb")!;
  const lie = compileMotion(createBodyAction("lie_down"));
  const recoverySeconds = lie.duration * .4;
  for (const next of ["run", "kneel"] as const) {
    for (const ordered of [false, true]) {
      const program = ordered
        ? applyCommands(createDance("idle"), JSON.stringify({ kind: "sequence", steps: [
            { instruction: "Lie down", commands: "action lie_down 1", mode: "perform" },
            { instruction: `Then ${next}`, commands: `action ${next} 1`, mode: "perform" },
          ] }))
        : createBodySequence([{ action: "lie_down", count: 1 }, { action: next, count: 1 }]);
      const timeline = validateRigProgram(program);
      const nextDuration = compileMotion(createBodyAction(next)).duration;
      expect(timeline.duration).toBeCloseTo(lie.duration + recoverySeconds + nextDuration + (ordered ? 0 : .28), 8);
      const boundaries = [lie.duration, lie.duration + recoverySeconds, lie.duration + recoverySeconds + .28];
      for (const boundary of boundaries) {
        const before = poseAt(timeline, boundary - 1e-7), after = poseAt(timeline, boundary + 1e-7);
        for (const joint of Object.keys(before))
          expect(distance(before[joint].position, after[joint].position), `${ordered ? "ordered" : "body"} lie→${next}: ${joint} at ${boundary}`).toBeLessThan(.001);
      }
      let minimumAnkle = Infinity, minimumKnee = Infinity, minimumHips = Infinity, minimumHead = Infinity;
      for (let frame = 0; frame <= 160; frame++) {
        const pose = poseAt(timeline, lie.duration + (recoverySeconds + .28) * frame / 160);
        for (const side of ["left", "right"]) {
          minimumAnkle = Math.min(minimumAnkle, pose[`${side}_ankle`].position[1]);
          minimumKnee = Math.min(minimumKnee, pose[`${side}_knee`].position[1]);
        }
        minimumHips = Math.min(minimumHips, pose.hips.position[1]);
        minimumHead = Math.min(minimumHead, pose.head.position[1]);
      }
      expect(minimumAnkle).toBeGreaterThan(.075);
      expect(minimumKnee).toBeGreaterThan(.09);
      expect(minimumHips).toBeGreaterThan(.1);
      expect(minimumHead).toBeGreaterThan(.1);
      const actual = poseAt(timeline, timeline.duration);
      const expected = poseAt(compileMotion(createBodyAction(next)), nextDuration);
      for (const joint of Object.keys(actual)) expect(distance(actual[joint].position, expected[joint].position)).toBeLessThan(1e-5);
    }
  }
  expect(() => validateRigProgram(createBodySequence([
    { action: "lie_down", count: 1 }, { action: "run", count: 1 },
    { action: "lie_down", count: 1 }, { action: "kneel", count: 1 },
  ]))).not.toThrow();
});

test("floor recovery survives an intervening joint gesture and preserves constrained arms at the boundary", () => {
  rig = rigs.get("gangnam-character.glb")!;
  const lieDuration = compileMotion(createBodyAction("lie_down")).duration;
  for (const commands of [
    ["action lie_down 1\narms still", "action run 1"],
    ["action lie_down 1", "joint head y 20", "action run 1"],
  ]) {
    const program = applyCommands(createDance("idle"), JSON.stringify({ kind: "sequence", steps:
      commands.map(commands => ({ instruction: commands, commands, mode: "perform" })),
    }));
    const timeline = validateRigProgram(program), cues = getOrderedSequenceCues(program);
    const recoveryStart = cues[cues.length - 1].start, recoveryDuration = lieDuration * .4;
    expect(cues[cues.length - 1].duration).toBeCloseTo(compileMotion(createBodyAction("run")).duration + recoveryDuration, 8);
    for (const boundary of [recoveryStart, recoveryStart + recoveryDuration]) {
      const before = poseAt(timeline, boundary - 1e-7), after = poseAt(timeline, boundary + 1e-7);
      for (const joint of Object.keys(before))
        expect(distance(before[joint].position, after[joint].position), `${commands.join(" → ")}: ${joint}`).toBeLessThan(.001);
    }
    let lowest = Infinity;
    for (let frame = 0; frame <= 100; frame++) {
      const pose = poseAt(timeline, recoveryStart + recoveryDuration * frame / 100);
      lowest = Math.min(lowest, pose.left_ankle.position[1], pose.right_ankle.position[1]);
    }
    expect(lowest).toBeGreaterThan(.075);
    if (commands.length === 3) {
      const head = (time: number) => sampleTimeline(timeline, time).find(pose => pose.target === "head" && pose.axis === "y")?.value ?? 0;
      expect(head(recoveryStart)).toBeCloseTo(20, 8);
      expect(head(recoveryStart + recoveryDuration * .5)).toBeCloseTo(10, 8);
      expect(head(recoveryStart + recoveryDuration)).toBeCloseTo(0, 8);
    }
  }
});
