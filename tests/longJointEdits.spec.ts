import { expect, test } from "@playwright/test";
import { createBodySequence } from "../src/motion/bodyActions";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { changeMotionHand } from "../src/motion/relative";
import {
  armBranch,
  changeTempo,
  findJointDetail,
  jointOffset,
  replaceArms,
} from "../src/motion/skills";
import type { MotionProgram, PoseValue } from "../src/motion/types";

const longBody = (bpm = 108) =>
  createBodySequence(
    [
      { action: "walk", count: 8 },
      { action: "run", count: 8 },
    ],
    bpm,
  );

function importedTenMinuteMotion(): MotionProgram {
  return {
    version: 2,
    title: "Long imported arm study",
    bpm: 30,
    root: {
      id: "motion",
      label: "Motion",
      kind: "parallel",
      children: [
        {
          id: "arms",
          label: "Arms",
          kind: "parallel",
          children: [
            {
              id: "imported.phrases",
              label: "Five phrases",
              kind: "repeat",
              count: 5,
              children: [armBranch("still", 120, "imported.arms")],
            },
          ],
        },
      ],
    },
  };
}

const valueAt = (poses: PoseValue[], target: string, axis: string) =>
  poses.find(
    (pose) =>
      pose.target === target &&
      pose.channel === "rotation" &&
      pose.axis === axis,
  )?.value;
const withoutArms = (poses: PoseValue[]) =>
  poses.filter(
    (pose) =>
      !/^(left|right)_(clavicle|shoulder|elbow|wrist|thumb|index|middle|ring|pinky)(_|$)/.test(
        pose.target,
      ),
  );

test("a valid long action sequence accepts joint edits across its entire duration and preserves selection on upsert", () => {
  const original = longBody(30),
    saved = JSON.stringify(original);
  const baseline = compileMotion(original);
  expect(baseline.duration).toBeGreaterThan(120);
  const first = jointOffset(original, "head", "y", 20);
  const selected = findJointDetail(first, "head", "y")!;
  expect(selected.kind).toBe("curve");
  expect(selected.id).toBe("detail.head.y");
  expect(findNode(first.root, selected.id)).toBe(selected);
  const updated = jointOffset(
    jointOffset(first, "neck", "z", 12),
    "head",
    "y",
    35,
  );
  expect(findJointDetail(updated, "head", "y")!.id).toBe(selected.id);
  const timeline = compileMotion(updated);
  expect(timeline.duration).toBe(baseline.duration);
  expect(timeline.tracks.every((track) => track.duration <= 120)).toBe(true);
  for (const fraction of [0, 0.1, 0.49, 0.5, 0.51, 0.93, 1]) {
    const actual = sampleTimeline(timeline, timeline.duration * fraction);
    expect(valueAt(actual, "head", "y")).toBe(35);
    expect(valueAt(actual, "neck", "z")).toBe(12);
    expect(
      actual.filter(
        (pose) =>
          !(pose.target === "head" && pose.axis === "y") &&
          !(pose.target === "neck" && pose.axis === "z"),
      ),
    ).toEqual(sampleTimeline(baseline, baseline.duration * fraction));
  }
  expect(JSON.stringify(original)).toBe(saved);
});

test("a ten-minute wiggle retains four cycles through every segment seam, hand switch, and repeated edit", () => {
  const original = importedTenMinuteMotion();
  const edited = jointOffset(original, "left_index_1", "z", 60, true);
  const firstId = findJointDetail(edited, "left_index_1", "z")!.id;
  const timeline = compileMotion(edited);
  expect(timeline.duration).toBe(600);
  const times = Array.from({ length: 501 }, (_, index) => index * 1.2);
  for (const boundary of [120, 240, 360, 480])
    times.push(boundary - 1e-7, boundary, boundary + 1e-7);
  for (const time of times) {
    const expected = 30 * (1 - Math.cos((8 * Math.PI * time) / 600));
    expect(
      valueAt(sampleTimeline(timeline, time), "left_index_1", "z"),
    ).toBeCloseTo(expected, 9);
  }
  const mirrored = changeMotionHand(edited, "right");
  const updated = jointOffset(mirrored, "right_index_1", "z", -45, true);
  expect(findJointDetail(updated, "right_index_1", "z")!.id).toBe(firstId);
  const both = jointOffset(updated, "left_index_1", "z", 17);
  expect(findJointDetail(both, "left_index_1", "z")!.id).not.toBe(firstId);
  const final = compileMotion(both);
  for (const time of [0, 75, 120, 239, 300, 480, 599, 600]) {
    const poses = sampleTimeline(final, time);
    expect(valueAt(poses, "left_index_1", "z")).toBe(17);
    expect(valueAt(poses, "right_index_1", "z")).toBeCloseTo(
      -22.5 * (1 - Math.cos((8 * Math.PI * time) / 600)),
      9,
    );
  }
});

test("joint and arm edits made before slowing a long sequence stay valid at 30 BPM without changing the actions", () => {
  const original = longBody();
  const slowBaseline = compileMotion(changeTempo(original, 30));
  for (const style of ["still", "robot"] as const) {
    const edited = replaceArms(
      jointOffset(original, "head", "y", 20, true),
      style,
    );
    const slow = compileMotion(changeTempo(edited, 30));
    expect(slow.duration).toBeCloseTo(slowBaseline.duration, 9);
    expect(slow.tracks.every((track) => track.duration <= 120)).toBe(true);
    for (let index = 0; index <= 100; index++) {
      const fraction = index / 100,
        time = slow.duration * fraction;
      const actual = sampleTimeline(slow, time);
      expect(valueAt(actual, "head", "y")).toBeCloseTo(
        10 * (1 - Math.cos(8 * Math.PI * fraction)),
        9,
      );
      const body = withoutArms(actual).filter(
        (pose) => !(pose.target === "head" && pose.axis === "y"),
      );
      const expected = withoutArms(
        sampleTimeline(slowBaseline, slowBaseline.duration * fraction),
      );
      expect(body.map(({ value: _, ...channel }) => channel)).toEqual(
        expected.map(({ value: _, ...channel }) => channel),
      );
      body.forEach((pose, index) =>
        expect(pose.value).toBeCloseTo(expected[index].value, 10),
      );
    }
  }
});

test("bounded robot arm phrases cover imported long motions with continuous repeat seams", () => {
  const original = importedTenMinuteMotion();
  const timeline = compileMotion(replaceArms(original, "robot"));
  expect(timeline.duration).toBe(600);
  expect(timeline.tracks.every((track) => track.duration <= 120)).toBe(true);
  const samples = [0, 120, 240, 360, 480, 600];
  for (const time of samples) {
    expect(valueAt(sampleTimeline(timeline, time), "left_shoulder", "x")).toBe(
      -20,
    );
    expect(valueAt(sampleTimeline(timeline, time), "left_elbow", "x")).toBe(
      -75,
    );
    expect(valueAt(sampleTimeline(timeline, time), "left_wrist", "x")).toBe(
      -35,
    );
  }
  for (const time of samples.slice(1, -1)) {
    const before = sampleTimeline(timeline, time - 1e-6);
    const after = sampleTimeline(timeline, time + 1e-6);
    for (const pose of before)
      expect(valueAt(after, pose.target, pose.axis)).toBeCloseTo(pose.value, 8);
  }
});
