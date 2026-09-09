import { expect, test } from "@playwright/test";
import {
  branchTargets,
  resolveEditTarget,
  editingBlockReason,
  fingerTargets,
  freezeTargets,
  restoreFrozen,
  rotationMagnitude,
  withRotationMagnitude,
} from "../src/motion/editing";
import {
  compileMotion,
  findNode,
  sampleTimeline,
  updateNode,
} from "../src/motion/engine";
import { createFingerRipple } from "../src/motion/dexterity";
import { createDexteritySequence } from "../src/motion/dexteritySequence";
import type { CurveNode, MotionProgram, PoseValue } from "../src/motion/types";

const values = (pose: PoseValue[], targets: string[]) =>
  Object.fromEntries(
    targets.flatMap((target) =>
      ["x", "y", "z"].map((axis) => [
        `${target}.${axis}`,
        pose.find(
          (value) =>
            value.target === target &&
            value.axis === axis &&
            value.channel === "rotation",
        )?.value ?? 0,
      ]),
    ),
  );
const leaf = (
  id: string,
  target: string,
  curve: CurveNode["curve"],
  duration = 2,
): CurveNode => ({
  id,
  label: id,
  kind: "curve",
  target,
  channel: "rotation",
  axis: "z",
  duration,
  curve,
});
const program = (root: MotionProgram["root"]): MotionProgram => ({
  version: 2,
  title: "Editing test",
  bpm: 108,
  root,
});

test("a finger pause holds all three sampled segments through pulses and gaps while every other channel stays unchanged", () => {
  for (const side of ["left", "right"] as const) {
    const original = createFingerRipple(side);
    const saved = structuredClone(original);
    const branch = findNode(original.root, `ripple.${side}.ring`)!;
    const targets = fingerTargets(side, "ring");
    expect(branchTargets(branch)).toEqual(targets);
    const before = compileMotion(original);
    const at = before.duration * 0.14;
    const held = values(sampleTimeline(before, at), targets);
    expect(Math.max(...Object.values(held).map(Math.abs))).toBeGreaterThan(20);
    const frozen = freezeTargets(original, targets, at);
    const after = compileMotion(frozen.program);
    expect(frozen.program.root.id).toBe(original.root.id);
    expect(after.duration).toBe(before.duration);
    for (let i = 0; i <= 50; i++) {
      const time = (before.duration * i) / 50;
      expect(values(sampleTimeline(after, time), targets)).toEqual(held);
      expect(
        sampleTimeline(after, time).filter(
          (value) => !targets.includes(value.target),
        ),
      ).toEqual(
        sampleTimeline(before, time).filter(
          (value) => !targets.includes(value.target),
        ),
      );
    }
    expect(original).toEqual(saved);
    expect(restoreFrozen(frozen.program, frozen.token)).toEqual(original);
  }
});

test("pauses sample combined add/replace channels and support long sequence roots", () => {
  const original = program({
    id: "sequence",
    label: "Long sequence",
    kind: "repeat",
    count: 5,
    children: [
      {
        id: "phrase",
        label: "Phrase",
        kind: "parallel",
        children: [
          leaf("add", "head", { kind: "constant", value: 10 }, 60),
          {
            ...leaf(
              "replace",
              "head",
              { kind: "sine", amplitude: 12, cycles: 2, offset: -3 },
              60,
            ),
            blend: "replace",
          },
          leaf("extra", "head", { kind: "constant", value: 5 }, 60),
          leaf(
            "neighbor",
            "neck",
            { kind: "sine", amplitude: 5, cycles: 1 },
            60,
          ),
        ],
      },
    ],
  });
  const before = compileMotion(original);
  const held = values(sampleTimeline(before, 8), ["head"]);
  const frozen = freezeTargets(original, ["head"], 8);
  const timeline = compileMotion(frozen.program);
  expect(timeline.duration).toBe(300);
  expect(frozen.token.wrapped).toBe(true);
  for (const time of [0, 59.9, 60, 119.99, 120, 239.99, 240, 300]) {
    expect(values(sampleTimeline(timeline, time), ["head"])).toEqual(held);
    expect(values(sampleTimeline(timeline, time), ["neck"])).toEqual(
      values(sampleTimeline(before, time), ["neck"]),
    );
  }
  expect(restoreFrozen(frozen.program, frozen.token)).toEqual(original);
});

test("restoration preserves unrelated edits and supports multiple pauses in either restoration order", () => {
  const original = createFingerRipple();
  const first = freezeTargets(original, fingerTargets("left", "ring"), 0.6);
  const second = freezeTargets(
    first.program,
    fingerTargets("left", "index"),
    1.2,
  );
  const modified = withRotationMagnitude(
    second.program,
    "ripple.left.middle.2",
    35,
  );
  let restored = restoreFrozen(modified, first.token);
  restored = restoreFrozen(restored, second.token);
  expect(restored).toEqual(
    withRotationMagnitude(original, "ripple.left.middle.2", 35),
  );
  expect(() => restoreFrozen(restored, first.token)).toThrow("no longer");

  const sequenced = program({
    id: "sequence",
    label: "Sequence",
    kind: "sequence",
    children: [
      leaf("one", "head", { kind: "sine", amplitude: 20, cycles: 1 }),
      leaf("two", "neck", { kind: "sine", amplitude: 10, cycles: 1 }),
    ],
  });
  for (const reverse of [false, true]) {
    const a = freezeTargets(sequenced, ["head"], 0.3);
    const b = freezeTargets(a.program, ["neck"], 2.4);
    const tokens = reverse ? [b.token, a.token] : [a.token, b.token];
    expect(
      tokens.reduce(
        (current, token) => restoreFrozen(current, token),
        b.program,
      ),
    ).toEqual(sequenced);
  }
});

test("curl magnitude preserves signed key shapes and restores from zero with a retained reference", () => {
  for (const side of ["left", "right"] as const) {
    const original = createFingerRipple(side);
    const id = `ripple.${side}.ring.2`;
    const node = findNode(original.root, id) as CurveNode;
    expect(rotationMagnitude(node)).toEqual({
      label: "Curl (°)",
      value: 65,
      max: 180,
    });
    const edited = withRotationMagnitude(original, id, 100);
    const next = findNode(edited.root, id) as CurveNode;
    expect(next.curve.kind).toBe("keys");
    if (node.curve.kind === "keys" && next.curve.kind === "keys") {
      expect(next.curve.points.map(([time]) => time)).toEqual(
        node.curve.points.map(([time]) => time),
      );
      expect(next.curve.points.map(([, value]) => value)).toEqual(
        node.curve.points.map(([, value]) => (value * 100) / 65),
      );
      expect(next.curve.interpolation).toBe(node.curve.interpolation);
      expect(
        next.curve.points.some(
          ([, value]) => value === (side === "left" ? 100 : -100),
        ),
      ).toBe(true);
    }
    expect(findNode(edited.root, `ripple.${side}.ring.1`)).toEqual(
      findNode(original.root, `ripple.${side}.ring.1`),
    );
    const zeroed = withRotationMagnitude(edited, id, 0, node);
    expect(() => withRotationMagnitude(zeroed, id, 65)).toThrow("reference");
    expect(withRotationMagnitude(zeroed, id, 65, node)).toEqual(original);
  }
});

test("magnitude controls preserve sine phase, offset ratio and constant curl handedness", () => {
  const oscillator = leaf("wave", "right_index_1", {
    kind: "sine",
    amplitude: -20,
    offset: -20,
    cycles: 3,
    phase: 0.37,
  });
  const original = program(oscillator);
  expect(rotationMagnitude(oscillator)?.value).toBe(40);
  const doubled = withRotationMagnitude(original, "wave", 80);
  expect((doubled.root as CurveNode).curve).toEqual({
    kind: "sine",
    amplitude: -40,
    offset: -40,
    cycles: 3,
    phase: 0.37,
  });
  expect(
    withRotationMagnitude(
      withRotationMagnitude(original, "wave", 0),
      "wave",
      40,
      oscillator,
    ),
  ).toEqual(original);
  const constant = program(
    leaf("held", "right_ring_1", { kind: "constant", value: 0 }),
  );
  expect(
    (withRotationMagnitude(constant, "held", 30).root as CurveNode).curve,
  ).toEqual({ kind: "constant", value: -30 });
  for (const degrees of [-1, NaN, Infinity, 181])
    expect(() => withRotationMagnitude(original, "wave", degrees)).toThrow();
  expect(() =>
    withRotationMagnitude(original, "wave", 20, {
      ...oscillator,
      target: "left_index_1",
    }),
  ).toThrow("reference");
});

test("contact and IK selections explain why the simple controls are unavailable", () => {
  const showcase = createDexteritySequence().program;
  for (const target of ["left_thumb_1", "left_ring_3", "left_wrist"]) {
    expect(editingBlockReason(showcase, [target])).toContain(
      "Contact choreography",
    );
    expect(() => freezeTargets(showcase, [target], 0.5)).toThrow(
      "Contact choreography",
    );
  }
  expect(editingBlockReason(showcase, ["left_hip"])).toContain("Foot IK");
  const ripple = createFingerRipple();
  expect(editingBlockReason(ripple, fingerTargets("left", "ring"))).toBeNull();
  expect(editingBlockReason(ripple, [])).toContain("Select");
  expect(editingBlockReason(ripple, ["left_hand_camera"])).toContain(
    "Only articulated",
  );
  expect(() => freezeTargets(ripple, ["left_ring_1"], NaN)).toThrow("finite");
  const node = findNode(ripple.root, "ripple.left.ring.1") as CurveNode;
  const contacted = {
    ...ripple,
    root: updateNode(ripple.root, "ripple.left.ring.1", () => ({
      ...node,
      target: "left_hand_camera",
    })),
  };
  expect(() => withRotationMagnitude(contacted, node.id, 30)).toThrow(
    "independent rotation",
  );
});

test("model edit tokens resolve explicit, active-hand and selected targets without guessing", () => {
  expect(resolveEditTarget("ring", "right", [])).toEqual(
    fingerTargets("right", "ring"),
  );
  expect(resolveEditTarget("left_ring", "right", [])).toEqual(
    fingerTargets("left", "ring"),
  );
  expect(resolveEditTarget("both_index_2", "left", [])).toEqual([
    "left_index_2",
    "right_index_2",
  ]);
  expect(resolveEditTarget("both_thumb", "right", [])).toEqual([
    ...fingerTargets("left", "thumb"),
    ...fingerTargets("right", "thumb"),
  ]);
  expect(resolveEditTarget("elbow", "right", [])).toEqual(["right_elbow"]);
  expect(resolveEditTarget("head", "left", [])).toEqual(["head"]);
  expect(
    resolveEditTarget("selected", "left", ["head", "neck", "head"]),
  ).toEqual(["head", "neck"]);
  expect(() => resolveEditTarget("selected", "left", [])).toThrow(
    "Select a joint",
  );
  for (const target of [
    "left_ring_4",
    "both_head",
    "left_ring extra",
    "ring\nfreeze head",
    "Ring",
    "left_hips",
    "unknown",
  ])
    expect(() => resolveEditTarget(target, "left", [])).toThrow(
      "Unknown motion edit target",
    );
});
