import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  BODY_ACTIONS,
  createBodyAction,
  createBodySequence,
} from "../src/motion/bodyActions";
import { createDexteritySequence } from "../src/motion/dexteritySequence";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { changeTempo, createDance, jointOffset } from "../src/motion/skills";
import type { Timeline } from "../src/motion/types";
import { sampleContacts } from "../src/motion/engine";

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
test.afterAll(() => {
  rig?.props.dispose();
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

test("all authored body actions are finite, editable, clear hand props and retain detail/tempo controls", () => {
  const tweet = createDexteritySequence().program;
  const saved = JSON.stringify(tweet);
  for (const action of BODY_ACTIONS) {
    const program = applyCommands(tweet, `action ${action} 2`);
    expect(program.props ?? []).toEqual([]);
    const timeline = validateRigProgram(program);
    expect(timeline.contacts ?? []).toEqual([]);
    const edited = compileMotion(jointOffset(program, "head", "y", 20));
    const slow = compileMotion(changeTempo(program, 54));
    expect(slow.duration).toBeCloseTo(timeline.duration * 2, 9);
    for (let frame = 0; frame <= 48; frame++) {
      const time = (timeline.duration * frame) / 48;
      const pose = poseAt(timeline, time);
      expect(
        Object.values(pose)
          .flatMap((joint) => [...joint.position, ...joint.quaternion])
          .every(Number.isFinite),
      ).toBe(true);
      expect(rig.props.snapshot()).toEqual({});
      const base =
        sampleTimeline(timeline, time).find(
          (value) => value.target === "head" && value.axis === "y",
        )?.value ?? 0;
      expect(
        sampleTimeline(edited, time).find(
          (value) => value.target === "head" && value.axis === "y",
        )!.value,
      ).toBeCloseTo(base + 20, 9);
    }
  }
  expect(JSON.stringify(tweet)).toBe(saved);
  for (const malformed of [
    "action jump 0",
    "action jump 9",
    "action jump two",
    "action fly 1",
    "action run 1 extra",
  ])
    expect(() => applyCommands(tweet, malformed)).toThrow();
});

test("jump twice has exactly two real airborne intervals and returns to the standing pose", () => {
  const program = createBodyAction("jump", 2),
    timeline = compileMotion(program);
  const rest = poseAt(timeline, 0),
    landing = poseAt(timeline, timeline.duration);
  let airborne = false,
    takeoffs = 0,
    maximumLift = 0;
  for (let frame = 0; frame <= 240; frame++) {
    const pose = poseAt(timeline, (timeline.duration * frame) / 240);
    const lift = Math.min(
      pose.left_ankle.position[1] - rest.left_ankle.position[1],
      pose.right_ankle.position[1] - rest.right_ankle.position[1],
    );
    maximumLift = Math.max(maximumLift, lift);
    if (lift > 0.08 && !airborne) {
      takeoffs++;
      airborne = true;
    }
    if (lift < 0.02) airborne = false;
    expect(pose.left_ankle.position[1]).toBeGreaterThanOrEqual(
      rest.left_ankle.position[1] - 0.001,
    );
    expect(pose.right_ankle.position[1]).toBeGreaterThanOrEqual(
      rest.right_ankle.position[1] - 0.001,
    );
  }
  expect(takeoffs).toBe(2);
  expect(maximumLift).toBeGreaterThan(0.32);
  for (const target of Object.keys(rest))
    expect(
      distance(rest[target].position, landing[target].position),
      target,
    ).toBeLessThan(1e-6);
});

test("walk and run have alternating strides; running lifts knees higher and swings bent arms faster", () => {
  const stats = BODY_ACTIONS.filter(
    (action) => action === "walk" || action === "run",
  ).map((action) => {
    const timeline = compileMotion(createBodyAction(action)),
      rest = poseAt(compileMotion(createBodyAction("bow")), 0);
    let lift = 0,
      crossings = 0,
      lastFront = false,
      armRange = [Infinity, -Infinity];
    for (let frame = 0; frame <= 240; frame++) {
      const pose = poseAt(timeline, (timeline.duration * frame) / 240);
      const leftFront =
        pose.left_ankle.position[2] > pose.right_ankle.position[2];
      if (frame && leftFront !== lastFront) crossings++;
      lastFront = leftFront;
      lift = Math.max(
        lift,
        pose.left_ankle.position[1] - rest.left_ankle.position[1],
      );
      armRange = [
        Math.min(armRange[0], pose.left_wrist.position[2]),
        Math.max(armRange[1], pose.left_wrist.position[2]),
      ];
    }
    const start = poseAt(timeline, 0),
      end = poseAt(timeline, timeline.duration);
    for (const target of Object.keys(start))
      expect(
        distance(start[target].position, end[target].position),
        `${action} ${target} loop seam`,
      ).toBeLessThan(1e-6);
    return { action, lift, crossings, armRange: armRange[1] - armRange[0] };
  });
  expect(stats[0].crossings).toBe(4);
  expect(stats[1].crossings).toBe(8);
  expect(stats[0].lift).toBeGreaterThan(0.08);
  expect(stats[1].lift).toBeGreaterThan(0.25);
  expect(stats[0].armRange).toBeGreaterThan(0.3);
  expect(stats[1].armRange).toBeGreaterThan(0.3);
  const rest = poseAt(compileMotion(createBodyAction("bow")), 0);
  const running = poseAt(compileMotion(createBodyAction("run")), 0);
  expect(
    new Quaternion(
      ...(rest.left_elbow.quaternion as [number, number, number, number]),
    ).angleTo(
      new Quaternion(
        ...(running.left_elbow.quaternion as [number, number, number, number]),
      ),
    ),
  ).toBeGreaterThan(1);
});

test("bow visibly lowers the head forward, crouch bends the legs, sit holds near the floor", () => {
  const baseline = poseAt(compileMotion(createBodyAction("bow")), 0);
  const bow = compileMotion(createBodyAction("bow"));
  const bowed = poseAt(bow, bow.duration * 0.5);
  expect(bowed.head.position[1]).toBeLessThan(baseline.head.position[1] - 0.2);
  expect(bowed.head.position[2]).toBeGreaterThan(
    baseline.head.position[2] + 0.3,
  );
  const crouch = compileMotion(createBodyAction("crouch")),
    crouched = poseAt(crouch, crouch.duration * 0.5);
  expect(crouched.hips.position[1]).toBeLessThan(
    baseline.hips.position[1] - 0.3,
  );
  for (const side of ["left", "right"]) {
    expect(
      distance(
        crouched[`${side}_ankle`].position,
        baseline[`${side}_ankle`].position,
      ),
    ).toBeLessThan(0.001);
    expect(crouched[`${side}_knee`].position[2]).toBeGreaterThan(
      baseline[`${side}_knee`].position[2] + 0.15,
    );
  }
  const sit = compileMotion(createBodyAction("sit")),
    seated = poseAt(sit, sit.duration);
  expect(seated.hips.position[1]).toBeLessThan(0.3);
  expect(seated.left_ankle.position[2]).toBeGreaterThan(
    baseline.left_ankle.position[2] + 0.35,
  );
  expect(poseAt(sit, sit.duration * 0.75)).toEqual(seated);
});

test("left/right kicks visibly extend the selected foot while the support foot stays planted", () => {
  for (const side of ["left", "right"] as const) {
    const timeline = compileMotion(createBodyAction(`kick_${side}`)),
      base = poseAt(timeline, 0);
    const kicked = poseAt(timeline, timeline.duration * 0.5),
      support = side === "left" ? "right" : "left";
    expect(
      kicked[`${side}_ankle`].position[1] - base[`${side}_ankle`].position[1],
    ).toBeGreaterThan(0.35);
    expect(
      kicked[`${side}_ankle`].position[2] - base[`${side}_ankle`].position[2],
    ).toBeGreaterThan(0.55);
    expect(
      distance(
        kicked[`${support}_ankle`].position,
        base[`${support}_ankle`].position,
      ),
    ).toBeLessThan(0.001);
  }
  const turn = compileMotion(createBodyAction("turn_left", 2));
  expect(
    sampleTimeline(turn, turn.duration).find(
      (value) => value.target === "root" && value.axis === "y",
    )!.value,
  ).toBe(180);
  const spin = compileMotion(createBodyAction("spin", 2));
  expect(
    sampleTimeline(spin, spin.duration).find(
      (value) => value.target === "root" && value.axis === "y",
    )!.value,
  ).toBe(720);
});

test("a half turn rotates the actual character and both feet by 180 degrees without changing its head pose", () => {
  for (const side of ["left", "right"] as const) {
    const timeline = compileMotion(createBodyAction(`turn_${side}`, 2));
    const before = poseAt(timeline, 0);
    const initialRoot = rig.scene.quaternion.clone().normalize();
    const initialHead = rig.joints.get("head")!.bone.quaternion.clone().normalize();
    const bodyJoints = ["left_ankle", "right_ankle", "hips"];
    const initialWorld = Object.fromEntries(bodyJoints.map((joint) =>
      [joint, rig.joints.get(joint)!.bone.getWorldQuaternion(new Quaternion()).normalize()]));
    const after = poseAt(timeline, timeline.duration);
    const finalRoot = rig.scene.quaternion.clone().normalize();
    expect(finalRoot.angleTo(initialRoot)).toBeCloseTo(Math.PI, 7);
    expect(rig.joints.get("head")!.bone.quaternion.clone().normalize().angleTo(initialHead)).toBeLessThan(1e-6);
    for (const joint of bodyJoints) {
      const original = new Vector3(...before[joint].position as [number, number, number]);
      const expected = original.applyAxisAngle(new Vector3(0, 1, 0), side === "left" ? Math.PI : -Math.PI);
      expect(distance(after[joint].position, expected.toArray()), `${side}: ${joint} turns with the body`).toBeLessThan(1e-6);
      const end = rig.joints.get(joint)!.bone.getWorldQuaternion(new Quaternion()).normalize();
      expect(end.angleTo(initialWorld[joint]), `${side}: ${joint} world rotation`).toBeCloseTo(Math.PI, 6);
    }
  }
});

test("multiple requested body actions keep their order, counts, and continuous transition endpoints", () => {
  const program = applyCommands(
    createBodyAction("walk"),
    "action run 1\naction jump 2\naction bow 1",
  );
  expect(program).toEqual(
    createBodySequence([
      { action: "run", count: 1 },
      { action: "jump", count: 2 },
      { action: "bow", count: 1 },
    ]),
  );
  expect(program.root.kind).toBe("parallel");
  const phases = findNode(program.root, "body_phases");
  if (phases?.kind !== "sequence") throw new Error("Expected body sequence.");
  expect(phases.children.map((node) => node.id)).toEqual([
    "body_step.0.motion",
    "body_transition.1",
    "body_step.1.body_action",
    "body_transition.2",
    "body_step.2.body_action",
  ]);
  const timeline = compileMotion(program);
  let start = 0;
  for (const child of phases.children.slice(0, -1)) {
    start += compileMotion({ ...program, root: child }).duration;
    const before = poseAt(timeline, start - 1e-7),
      after = poseAt(timeline, start + 1e-7);
    for (const target of Object.keys(before)) {
      expect(
        distance(before[target].position, after[target].position),
        `${child.id} ${target}`,
      ).toBeLessThan(0.0001);
      const a = new Quaternion(
        ...(before[target].quaternion as [number, number, number, number]),
      );
      const b = new Quaternion(
        ...(after[target].quaternion as [number, number, number, number]),
      );
      expect(a.angleTo(b), `${child.id} ${target}`).toBeLessThan(0.001);
    }
  }
  const edited = applyCommands(program, "wiggle left_index_1 z 50");
  expect(compileMotion(edited).duration).toBe(timeline.duration);
});

test("arm follow-ups preserve every body phase and transition in an action sequence", () => {
  const original = createBodySequence([
    { action: "run_wave", count: 1 },
    { action: "jump", count: 2 },
    { action: "bow", count: 1 },
  ]);
  const timeline = compileMotion(original);
  for (const style of ["still", "natural", "robot", "wave"]) {
    const next = compileMotion(applyCommands(original, `arms ${style}`));
    expect(next.duration).toBeCloseTo(timeline.duration, 9);
    for (let frame = 0; frame <= 40; frame++) {
      const time = (timeline.duration * frame) / 40;
      const expected = poseAt(timeline, time),
        actual = poseAt(next, time);
      for (const target of [
        "hips",
        "head",
        "left_hip",
        "right_hip",
        "left_knee",
        "right_knee",
        "left_ankle",
        "right_ankle",
      ])
        expect(
          distance(actual[target].position, expected[target].position),
          `${style} ${target}`,
        ).toBeLessThan(1e-6);
    }
  }
});

test("turning preserves the walking frame, planted targets, and explicit leg edits in later actions", () => {
  for (const side of ["left", "right"] as const) {
    const heading = side === "left" ? Math.PI / 2 : -Math.PI / 2;
    const rotation = new Quaternion().setFromAxisAngle(
      new Vector3(0, 1, 0),
      heading,
    );
    const gait = compileMotion(
      jointOffset(createBodyAction("run"), "left_hip", "x", -25),
    );
    const sequence = compileMotion(
      jointOffset(
        createBodySequence([
          { action: `turn_${side}`, count: 1 },
          { action: "run", count: 1 },
        ]),
        "left_hip",
        "x",
        -25,
      ),
    );
    const offset =
      compileMotion(createBodyAction(`turn_${side}`)).duration + 0.28;
    for (const fraction of [0.07, 0.19, 0.34, 0.62, 0.91]) {
      const base = poseAt(gait, gait.duration * fraction),
        turned = poseAt(sequence, offset + gait.duration * fraction);
      for (const target of Object.keys(base)) {
        const expected = new Vector3(
          ...(base[target].position as [number, number, number]),
        )
          .applyQuaternion(rotation)
          .toArray();
        expect(
          distance(turned[target].position, expected),
          `${side} ${target} at ${fraction}`,
        ).toBeLessThan(0.00001);
      }
    }
  }
  const carried = compileMotion(
    createBodySequence([
      { action: "turn_left", count: 1 },
      { action: "jump", count: 2 },
      { action: "bow", count: 1 },
    ]),
  );
  const firstTurn = compileMotion(createBodyAction("turn_left")).duration;
  for (const fraction of [0.01, 0.25, 0.6, 1]) {
    const time = firstTurn + (carried.duration - firstTurn) * fraction;
    expect(
      sampleTimeline(carried, time).find(
        (value) =>
          value.target === "root" &&
          value.channel === "rotation" &&
          value.axis === "y",
      )!.value,
    ).toBe(90);
  }
  expect(() =>
    createBodySequence(
      Array.from({ length: 5 }, () => ({ action: "jump", count: 1 })),
    ),
  ).toThrow();
  expect(() =>
    createBodySequence([
      { action: "jump", count: 8 },
      { action: "bow", count: 8 },
      { action: "run", count: 1 },
    ]),
  ).toThrow();
});

test("walking and running waves preserve the gait and left arm, and end before the next bow", () => {
  for (const action of ["walk", "run"] as const) {
    const base = compileMotion(createBodyAction(action)),
      waved = compileMotion(createBodyAction(`${action}_wave`));
    for (const fraction of [0.04, 0.25, 0.59, 0.91]) {
      const normal = poseAt(base, base.duration * fraction),
        waving = poseAt(waved, waved.duration * fraction);
      for (const target of [
        "hips",
        "left_hip",
        "right_hip",
        "left_knee",
        "right_knee",
        "left_ankle",
        "right_ankle",
        "left_wrist",
        "left_shoulder",
        "left_elbow",
      ])
        expect(
          distance(normal[target].position, waving[target].position),
          `${action} ${target}`,
        ).toBeLessThan(1e-6);
      expect(
        distance(normal.right_wrist.position, waving.right_wrist.position),
      ).toBeGreaterThan(0.2);
    }
  }
  const sequence = compileMotion(
    createBodySequence([
      { action: "walk_wave", count: 1 },
      { action: "bow", count: 1 },
    ]),
  );
  const bow = compileMotion(createBodyAction("bow"));
  const offset = compileMotion(createBodyAction("walk_wave")).duration + 0.28;
  for (const fraction of [0.1, 0.5, 0.9]) {
    const actual = poseAt(sequence, offset + bow.duration * fraction),
      expected = poseAt(bow, bow.duration * fraction);
    for (const target of Object.keys(actual))
      expect(
        distance(actual[target].position, expected[target].position),
        target,
      ).toBeLessThan(1e-6);
  }
});

test("hand skills start fresh after finite actions and sequences while cyclic gaits keep their footwork", () => {
  const sequence = createBodySequence([
    { action: "run", count: 1 },
    { action: "jump", count: 2 },
    { action: "bow", count: 1 },
  ]);
  const commands = [
    "skill finger_ripple left forward",
    "skill finger_ripple left reverse",
    "skill finger_touches left forward",
    "skill coin_roll left forward",
  ];
  for (const previous of [
    createBodyAction("jump", 2),
    sequence,
    applyCommands(sequence, "joint head y 20"),
  ]) {
    const saved = JSON.stringify(previous);
    for (const command of commands) {
      const next = applyCommands(previous, command);
      expect(next).toEqual(
        applyCommands(createDance("idle", "still", previous.bpm), command),
      );
      const timeline = compileMotion(next);
      const initial = poseAt(timeline, 0);
      for (const fraction of [0.1, 0.35, 0.6, 0.9]) {
        const actual = poseAt(timeline, timeline.duration * fraction);
        for (const target of ["left_ankle", "right_ankle"])
          expect(
            distance(actual[target].position, initial[target].position),
          ).toBeLessThan(1e-6);
      }
    }
    expect(JSON.stringify(previous)).toBe(saved);
  }
  for (const action of ["walk", "run", "walk_wave", "run_wave"] as const) {
    const original = createBodyAction(action),
      gait = compileMotion(original);
    const next = compileMotion(applyCommands(original, commands[0]));
    for (const fraction of [0.08, 0.2, 0.43, 0.85]) {
      const time = gait.duration * fraction;
      const expected = poseAt(gait, time),
        actual = poseAt(next, time);
      for (const target of [
        "left_hip",
        "right_hip",
        "left_knee",
        "right_knee",
        "left_ankle",
        "right_ankle",
      ])
        expect(
          distance(actual[target].position, expected[target].position),
          `${action} ${target}`,
        ).toBeLessThan(1e-6);
    }
  }
});
