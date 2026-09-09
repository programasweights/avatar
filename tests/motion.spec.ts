import { expect, test } from "@playwright/test";
import {
  activeNodes,
  compileMotion,
  findNode,
  sampleCurve,
  sampleTimeline,
} from "../src/motion/engine";
import {
  changeTempo,
  createDance,
  jointOffset,
  replaceArms,
} from "../src/motion/skills";
import { applyCommands, validateRigProgram } from "../src/motion/director";

import type { CurveNode, MotionProgram } from "../src/motion/types";

test("nested sequence / repeat / parallel have precise timing and no boundary overlap", () => {
  const leaf = (id: string, value: number, duration: number): CurveNode => ({
    id,
    kind: "curve",
    label: id,
    target: "head",
    channel: "rotation",
    axis: "x",
    duration,
    curve: { kind: "constant", value },
  });
  const program: MotionProgram = {
    version: 2,
    title: "Timing",
    bpm: 120,
    root: {
      id: "root",
      kind: "sequence",
      label: "Sequence",
      children: [
        {
          id: "repeat",
          kind: "repeat",
          label: "Repeat",
          count: 2,
          children: [leaf("a", 10, 1), leaf("b", 20, 2)],
        },
        {
          id: "parallel",
          kind: "parallel",
          label: "Parallel",
          children: [leaf("c", 30, 2), { ...leaf("d", 40, 1), axis: "y" }],
        },
      ],
    },
  };
  const t = compileMotion(program);
  expect(t.duration).toBe(8);
  expect(t.tracks.map((x) => x.start)).toEqual([0, 1, 3, 4, 6, 6]);
  expect(sampleTimeline(t, 1)).toEqual([
    { target: "head", axis: "x", channel: "rotation", value: 20 },
  ]);
  expect(sampleTimeline(t, 6).map((x) => x.value)).toEqual([30, 40]);
  expect(sampleTimeline(t, 8).map((x) => x.value)).toEqual([30]);
  expect(activeNodes(t, 4).has("repeat")).toBe(true);
});
test("arm edits and finger edits preserve every foot trajectory", () => {
  const original = createDance("salsa");
  const edited = jointOffset(
    replaceArms(original, "robot"),
    "left_index_1",
    "z",
    60,
  );
  expect(findNode(edited.root, "feet")).toEqual(
    findNode(original.root, "feet"),
  );
  const a = compileMotion(original),
    b = compileMotion(edited);
  for (let i = 0; i <= 32; i++) {
    const foot = (t: typeof a) =>
      sampleTimeline(t, (t.duration * i) / 32).filter((v) =>
        v.target.endsWith("_ik"),
      );
    expect(foot(b)).toEqual(foot(a));
  }
});
test("tempo rescales timing but preserves poses at the same beat", () => {
  const a = compileMotion(createDance("cha_cha"));
  const b = compileMotion(changeTempo(createDance("cha_cha"), 72));
  expect(b.duration / a.duration).toBeCloseTo(1.5);
  expect(sampleTimeline(b, b.duration * 0.6)).toEqual(
    sampleTimeline(a, a.duration * 0.6),
  );
});
test("reject malformed trees, duplicate IDs, invalid keyframe order and unknown joints", () => {
  const p = createDance("robot");
  const bad = structuredClone(p);
  bad.bpm = NaN;
  expect(() => compileMotion(bad)).toThrow();
  const root = p.root;
  if (root.kind === "curve" || root.kind === "contact") throw new Error();
  root.children.push(root.children[0]);
  expect(() => compileMotion(p)).toThrow("unique ID");
  const unordered = jointOffset(createDance("idle"), "head", "y", 20);
  const curve = findNode(unordered.root, "detail.head.y");
  if (curve?.kind !== "curve")
    throw new Error("Expected an editable head curve.");
  curve.curve = {
    kind: "keys",
    points: [
      [0, 0],
      [0.8, 20],
      [0.5, 10],
      [1, 0],
    ],
  };
  expect(() => compileMotion(unordered)).toThrow(
    "Keyframe times must increase",
  );
  const wrong = jointOffset(createDance("idle"), "imaginary_joint", "x", 20);
  expect(() => validateRigProgram(wrong)).toThrow("Unknown joint");
  expect(() => applyCommands(createDance("salsa"), "dance ballet")).toThrow(
    "invalid command",
  );
  expect(() =>
    applyCommands(createDance("salsa"), "joint head y NaN"),
  ).toThrow();
});
test("smooth curves stay continuous and keyframe holds respect boundaries", () => {
  expect(
    sampleCurve(
      {
        kind: "keys",
        points: [
          [0, 0],
          [0.5, 60],
          [1, 0],
        ],
      },
      0.5,
    ),
  ).toBe(60);
  expect(
    sampleCurve(
      {
        kind: "keys",
        interpolation: "hold",
        points: [
          [0, 10],
          [0.5, 20],
          [1, 30],
        ],
      },
      0.5,
    ),
  ).toBe(20);
  expect(
    sampleCurve(
      { kind: "sine", amplitude: 30, cycles: 1, phase: -0.25, offset: 30 },
      0,
    ),
  ).toBeCloseTo(0);
});
test("edits preserve duration inside repeated choreography", () => {
  const dance = createDance("salsa");
  const repeated: MotionProgram = {
    ...dance,
    root: {
      id: "three_cycles",
      label: "Three cycles",
      kind: "repeat",
      count: 3,
      children: [dance.root],
    },
  };
  const edited = jointOffset(
    replaceArms(repeated, "robot"),
    "left_index_1",
    "z",
    40,
  );
  expect(compileMotion(edited).duration).toBe(compileMotion(repeated).duration);
  expect(findNode(edited.root, "feet")).toEqual(
    findNode(repeated.root, "feet"),
  );
});
