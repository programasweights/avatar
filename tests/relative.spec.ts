import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fingertip } from "../src/motion/contacts";
import { createDexterity } from "../src/motion/dexterityDirector";
import { createDexteritySequence } from "../src/motion/dexteritySequence";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import {
  compileMotion,
  findNode,
  sampleContacts,
  sampleTimeline,
} from "../src/motion/engine";
import {
  branchTargets,
  fingerTargets,
  freezeTargets,
  restoreFrozen,
} from "../src/motion/editing";
import { MotionRig } from "../src/motion/rig";
import { motionHandFrame } from "../src/motion/MotionStage";
import { currentMotionHand } from "../src/motion/relative";
import { createDance, jointOffset, replaceArms } from "../src/motion/skills";
import type {
  CurveNode,
  MotionProgram,
  PoseValue,
  Timeline,
} from "../src/motion/types";

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

const key = (value: PoseValue) =>
  `${value.target}.${value.channel}.${value.axis}`;
function equalPose(actual: PoseValue[], expected: PoseValue[]) {
  const a = [...actual].sort((x, y) => key(x).localeCompare(key(y)));
  const b = [...expected].sort((x, y) => key(x).localeCompare(key(y)));
  expect(a.map(key)).toEqual(b.map(key));
  expect(
    a.filter((value, index) => Math.abs(value.value - b[index].value) > 1e-8),
  ).toEqual([]);
}
function equalContacts(
  actual: ReturnType<typeof sampleContacts>,
  expected: ReturnType<typeof sampleContacts>,
) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    for (const [key, value] of Object.entries(expected[i])) {
      const received = (actual[i] as unknown as Record<string, unknown>)[key];
      if (typeof value === "number") expect(received).toBeCloseTo(value, 8);
      else expect(received).toEqual(value);
    }
  }
}

test("other hand transforms authored studies and the default showcase without changing lower-body edits", () => {
  for (const side of ["left", "right"] as const) {
    const other = side === "left" ? "right" : "left";
    const pairs: [MotionProgram, MotionProgram][] = [
      ...(["finger_ripple", "finger_touches", "coin_roll"] as const).map(
        (skill): [MotionProgram, MotionProgram] => [
          createDexterity(skill, side),
          createDexterity(skill, other),
        ],
      ),
      [
        createDexteritySequence(undefined, side).program,
        createDexteritySequence(undefined, other).program,
      ],
    ];
    for (const [source, expected] of pairs) {
      const sourceEdited = jointOffset(source, "left_hip", "x", -35);
      const next = applyCommands(sourceEdited, "hand other");
      expect(currentMotionHand(next)).toBe(other);
      expect(next.title).toBe(expected.title);
      const timeline = validateRigProgram(next);
      const comparison = compileMotion(
        jointOffset(expected, "left_hip", "x", -35),
      );
      expect(timeline.duration).toBe(comparison.duration);
      for (const fraction of [0, 0.031, 0.147, 0.361, 0.619, 0.741, 0.929, 1]) {
        const time = timeline.duration * fraction;
        equalPose(
          sampleTimeline(timeline, time),
          sampleTimeline(comparison, time),
        );
        equalContacts(
          sampleContacts(timeline, time),
          sampleContacts(comparison, time),
        );
        apply(timeline, time);
        const frame = motionHandFrame(rig.joints, timeline, other);
        expect(
          [
            ...frame.position.toArray(),
            ...frame.target.toArray(),
            ...frame.up.toArray(),
          ].every(Number.isFinite),
        ).toBe(true);
      }
      const roundtrip = applyCommands(next, `hand ${side}`);
      expect(roundtrip.root).toEqual(sourceEdited.root);
    }
  }
});

test("actual mirrored contacts remain accurate and coin handoffs stay continuous", () => {
  for (const side of ["left", "right"] as const) {
    const other = side === "left" ? "right" : "left";
    const touches = validateRigProgram(
      applyCommands(
        createDexterity("finger_touches", side),
        "hand other\nreverse current",
      ),
    );
    for (const track of touches.contacts ?? []) {
      if (track.mode !== "fingertips")
        throw new Error("Expected fingertip contact.");
      apply(touches, track.start + track.duration * 0.5);
      const a = fingertip(rig.joints, track.effector).getWorldPosition(
        new Vector3(),
      );
      const b = fingertip(rig.joints, track.target).getWorldPosition(
        new Vector3(),
      );
      expect(a.distanceTo(b)).toBeLessThan(0.003);
      expect(track.effector.startsWith(other)).toBe(true);
    }
    const coin = validateRigProgram(
      applyCommands(
        createDexterity("coin_roll", side),
        "hand other\nreverse current",
      ),
    );
    const sample = (time: number) => {
      apply(coin, time);
      const value = rig.props.snapshot().coin;
      expect(value.visible).toBe(true);
      expect(
        [...value.position, ...value.quaternion].every(Number.isFinite),
      ).toBe(true);
      return {
        position: new Vector3(...(value.position as [number, number, number])),
        quaternion: new Quaternion(
          ...(value.quaternion as [number, number, number, number]),
        ),
      };
    };
    for (const track of coin.contacts ?? []) {
      sample(track.start + track.duration * 0.5);
      const boundary = track.start + track.duration;
      if (
        boundary >= coin.duration ||
        Math.abs(boundary - coin.duration / 2) < 1e-8
      )
        continue;
      const before = sample(boundary - 1e-6),
        after = sample(boundary + 1e-6);
      expect(before.position.distanceTo(after.position)).toBeLessThan(0.0001);
      expect(before.quaternion.angleTo(after.quaternion)).toBeLessThan(0.001);
    }
  }
});

test("reversal follows the entire actual timeline, including camera, props, visibility and joint edits", () => {
  for (const program of [
    createDexteritySequence().program,
    createDexterity("finger_ripple", "right"),
    applyCommands(createDance("salsa"), "skill coin_roll left forward"),
  ]) {
    const edited = applyCommands(
      program,
      "wiggle head y 17\njoint left_hip x -30",
    );
    const original = compileMotion(edited);
    const reversed = compileMotion(applyCommands(edited, "reverse current"));
    const roundtrip = compileMotion(
      applyCommands(edited, "reverse current\nreverse current"),
    );
    expect(reversed.duration).toBeCloseTo(original.duration, 10);
    expect(reversed.props).toEqual(original.props);
    for (let index = 0; index < 43; index++) {
      const time = (original.duration * (index + 0.137)) / 43;
      equalPose(
        sampleTimeline(reversed, time),
        sampleTimeline(original, original.duration - time),
      );
      equalContacts(
        sampleContacts(reversed, time),
        sampleContacts(original, original.duration - time),
      );
      equalPose(
        sampleTimeline(roundtrip, time),
        sampleTimeline(original, time),
      );
      apply(reversed, time);
      expect(
        Object.values(rig.snapshot())
          .flatMap((joint) => [...joint.position, ...joint.quaternion])
          .every(Number.isFinite),
      ).toBe(true);
    }
  }
});

test("paused and selected details survive hand changes, reversal, speed edits and restoration", () => {
  let original = applyCommands(
    createDexterity("finger_ripple"),
    "wiggle left_index_1 z 47\njoint head y 19",
  );
  const selectedId = "detail.left_index_1.z";
  const paused = freezeTargets(original, fingerTargets("left", "ring"), 0.41);
  const transformed = applyCommands(
    paused.program,
    "hand other\nreverse current\ntempo_scale 0.5",
  );
  const selected = findNode(transformed.root, selectedId) as CurveNode;
  expect(selected.target).toBe("right_index_1");
  expect(selected.curve.kind).toBe("sine");
  const token = {
    ...paused.token,
    targets: branchTargets(findNode(transformed.root, paused.token.id)!),
  };
  expect(token.targets).toEqual(fingerTargets("right", "ring"));
  const restored = restoreFrozen(transformed, token);
  const expected = applyCommands(
    original,
    "hand other\nreverse current\ntempo_scale 0.5",
  );
  expect(restored.root).toEqual(expected.root);
  expect(restored.bpm).toBe(54);
  const before = compileMotion(transformed);
  for (const fraction of [0.01, 0.31, 0.83]) {
    const rotations = sampleTimeline(before, before.duration * fraction).filter(
      (value) => value.target.startsWith("right_ring_"),
    );
    equalPose(
      rotations,
      sampleTimeline(before, 0).filter((value) =>
        value.target.startsWith("right_ring_"),
      ),
    );
  }
  // A later explicit edit replaces the mirrored detail instead of stacking it.
  const updated = compileMotion(
    applyCommands(restored, "joint right_index_1 z -65"),
  );
  expect(
    updated.tracks.filter(
      (track) =>
        track.id.startsWith("detail.") && track.target === "right_index_1",
    ),
  ).toHaveLength(1);
});

test("relative speed preserves the exact beat, contact progress and exported replay", () => {
  const original = createDexteritySequence().program;
  const normal = compileMotion(original);
  const twice = applyCommands(original, "tempo_scale 2");
  expect(twice.bpm).toBe(216);
  expect(compileMotion(twice).duration).toBeCloseTo(normal.duration / 2, 10);
  const slower = applyCommands(twice, "tempo_scale 0.75");
  expect(slower.bpm).toBe(162);
  const replay = compileMotion(
    JSON.parse(JSON.stringify(slower)) as MotionProgram,
  );
  for (const fraction of [0, 0.1, 0.4, 0.7, 0.93, 1]) {
    equalPose(
      sampleTimeline(replay, replay.duration * fraction),
      sampleTimeline(normal, normal.duration * fraction),
    );
    equalContacts(
      sampleContacts(replay, replay.duration * fraction),
      sampleContacts(normal, normal.duration * fraction),
    );
  }
  for (const command of [
    "tempo_scale 3",
    "tempo_scale 0.25",
    "tempo_scale 0",
    "tempo_scale 5",
    "tempo_scale NaN",
  ])
    expect(() => applyCommands(original, command)).toThrow();
  expect(original.bpm).toBe(108);
});

test("left and right hello waves only replace the requested arm and preserve actual footwork", () => {
  const baseline = compileMotion(createDance("salsa"));
  for (const side of ["left", "right"] as const) {
    const other = side === "left" ? "right" : "left";
    const waved = applyCommands(createDance("salsa"), `wave ${side}`);
    expect(currentMotionHand(waved)).toBe(side);
    const timeline = compileMotion(waved);
    const moved = compileMotion(applyCommands(waved, "hand other"));
    expect(currentMotionHand(applyCommands(waved, "hand other"))).toBe(other);
    for (const fraction of [0.031, 0.17, 0.31, 0.58, 0.87]) {
      const time = fraction * timeline.duration;
      const unchanged = (pose: PoseValue[], exclude: string) =>
        pose.filter(
          (value) =>
            !value.target.startsWith(exclude + "_") ||
            /_(hip|knee|ankle|toes|foot_ik)$/.test(value.target),
        );
      equalPose(
        unchanged(sampleTimeline(timeline, time), side),
        unchanged(sampleTimeline(baseline, time), side),
      );
      equalPose(
        unchanged(sampleTimeline(moved, time), other),
        unchanged(sampleTimeline(baseline, time), other),
      );
      apply(baseline, time);
      const base = rig.snapshot();
      apply(timeline, time);
      const current = rig.snapshot();
      for (const target of [`${other}_wrist`, "left_ankle", "right_ankle"])
        current[target].position.forEach((value, index) =>
          expect(value).toBeCloseTo(base[target].position[index], 8),
        );
      expect(
        new Vector3(
          ...(current[`${side}_wrist`].position as [number, number, number]),
        ).distanceTo(
          new Vector3(
            ...(base[`${side}_wrist`].position as [number, number, number]),
          ),
        ),
      ).toBeGreaterThan(0.1);
    }
  }
});

test("ambiguous and unsupported relative edits fail without mutating a custom scene", () => {
  const base = createDance("salsa");
  const both = applyCommands(
    base,
    "wiggle left_index_1 z 30\nwiggle right_index_1 z -30",
  );
  const conflicting = applyCommands(
    createDexterity("finger_ripple"),
    "wiggle right_index_1 z -30",
  );
  for (const program of [
    base,
    both,
    conflicting,
    createDexterity("arm_wave"),
  ]) {
    const saved = JSON.stringify(program);
    expect(() => applyCommands(program, "hand other")).toThrow();
    expect(JSON.stringify(program)).toBe(saved);
  }
  const uneven = structuredClone(base);
  (findNode(uneven.root, "torso.head") as CurveNode).duration *= 0.5;
  expect(() => applyCommands(uneven, "reverse current")).toThrow(
    "different lengths",
  );
  const held = structuredClone(base);
  (findNode(held.root, "torso.head") as CurveNode).curve = {
    kind: "keys",
    interpolation: "hold",
    points: [
      [0, 0],
      [0.5, 30],
      [1, 0],
    ],
  };
  expect(() => applyCommands(held, "reverse current")).toThrow(
    "held keyframes",
  );
});

test("switching a standalone finger detail keeps idle or salsa arms and footwork intact", () => {
  for (const style of ["idle", "salsa"] as const) {
    const original = applyCommands(
      createDance(style),
      "wiggle left_index_1 z 65",
    );
    const next = applyCommands(original, "hand other");
    expect(currentMotionHand(next)).toBe("right");
    expect(findNode(next.root, "arms")).toEqual(
      findNode(original.root, "arms"),
    );
    expect(findNode(next.root, "feet")).toEqual(
      findNode(original.root, "feet"),
    );
    const mirrored = findNode(next.root, "detail.left_index_1.z") as CurveNode;
    expect(mirrored.target).toBe("right_index_1");
    expect(mirrored.curve.kind === "sine" && mirrored.curve.amplitude).toBe(
      -32.5,
    );
    const edited = applyCommands(
      next,
      "joint right_index_1 z -40\nwiggle left_index_1 z 20",
    );
    const details = compileMotion(edited).tracks.filter((track) =>
      track.id.startsWith("detail."),
    );
    expect(details.map((track) => track.target).sort()).toEqual([
      "left_index_1",
      "right_index_1",
    ]);
    expect(findNode(edited.root, mirrored.id)).toMatchObject({
      target: "right_index_1",
      curve: { kind: "constant", value: -40 },
    });
  }
});

test("adding a wave rejects a nested short wave without stretching the imported sequence", () => {
  const waved = applyCommands(createDance("idle"), "wave left");
  const nested = findNode(waved.root, "hello_wave")!;
  const imported: MotionProgram = {
    version: 2,
    title: "A short wave, then a longer motion",
    bpm: 108,
    root: {
      id: "imported_sequence",
      kind: "sequence",
      label: "Two phases",
      children: [
        nested,
        {
          id: "second_phase",
          kind: "curve",
          label: "Head turn",
          target: "head",
          axis: "y",
          channel: "rotation",
          duration: 10,
          curve: { kind: "constant", value: 20 },
        },
      ],
    },
  };
  const saved = JSON.stringify(imported);
  const duration = compileMotion(imported).duration;
  expect(() => applyCommands(imported, "wave right")).toThrow(
    "top-level wave overlay",
  );
  expect(JSON.stringify(imported)).toBe(saved);
  expect(compileMotion(imported).duration).toBe(duration);

  // A reserved ID on unrelated custom content is not permission to overwrite it.
  const unrelated = structuredClone(waved);
  const overlay = findNode(unrelated.root, "hello_wave")!;
  if (overlay.kind !== "parallel") throw new Error("Expected wave overlay.");
  (overlay.children[0] as CurveNode).target = "head";
  const original = JSON.stringify(unrelated);
  expect(() => applyCommands(unrelated, "wave right")).toThrow(
    "top-level wave overlay",
  );
  expect(JSON.stringify(unrelated)).toBe(original);
});

test("joint details and pauses stay above a wave while new arm choreography replaces it", () => {
  const base = createDance("salsa");
  const waved = applyCommands(base, "wave left");
  const baseline = compileMotion(waved);
  const edited = compileMotion(applyCommands(waved, "joint left_elbow x -30"));
  const detailFirst = compileMotion(
    applyCommands(base, "joint left_elbow x -30\nwave left"),
  );
  for (const fraction of [0.031, 0.147, 0.481, 0.937]) {
    const time = baseline.duration * fraction;
    const elbow = (timeline: Timeline) =>
      sampleTimeline(timeline, time).find(
        (value) => value.target === "left_elbow" && value.axis === "x",
      )!.value;
    expect(elbow(edited)).toBeCloseTo(elbow(baseline) - 30, 10);
    equalPose(sampleTimeline(detailFirst, time), sampleTimeline(edited, time));
  }
  const paused = freezeTargets(base, ["left_elbow"], 0.71);
  const pausedWave = compileMotion(applyCommands(paused.program, "wave left"));
  const pausedValue = sampleTimeline(
    compileMotion(paused.program),
    0.71,
  ).filter((value) => value.target === "left_elbow");
  for (const fraction of [0.017, 0.347, 0.791])
    equalPose(
      sampleTimeline(pausedWave, pausedWave.duration * fraction).filter(
        (value) => value.target === "left_elbow",
      ),
      pausedValue,
    );
  for (const style of ["robot", "still", "natural", "wave"] as const) {
    const replaced = replaceArms(waved, style);
    expect(findNode(replaced.root, "hello_wave")).toBeUndefined();
    expect(replaced).toEqual(replaceArms(base, style));
  }
  for (const skill of [
    "finger_ripple",
    "finger_touches",
    "coin_roll",
  ] as const) {
    const command = `skill ${skill} left forward`;
    const next = applyCommands(waved, command);
    expect(findNode(next.root, "hello_wave")).toBeUndefined();
    expect(next).toEqual(applyCommands(base, command));
  }
});

test("arm and skill replacements retain custom content that only shares the wave ID", () => {
  const program = createDance("salsa");
  if (program.root.kind !== "parallel") throw new Error("Expected a dance.");
  const custom: CurveNode = {
    id: "hello_wave",
    label: "Custom head detail",
    kind: "curve",
    target: "head",
    axis: "y",
    channel: "rotation",
    duration: compileMotion(program).duration,
    curve: { kind: "constant", value: 10 },
  };
  program.root.children.push(custom);
  expect(findNode(replaceArms(program, "robot").root, "hello_wave")).toEqual(
    custom,
  );
  expect(
    findNode(
      applyCommands(program, "skill finger_ripple left forward").root,
      "hello_wave",
    ),
  ).toEqual(custom);
});
