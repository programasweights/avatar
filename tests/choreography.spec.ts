import { expect, test } from "@playwright/test";
import { compileMotion, sampleTimeline } from "../src/motion/engine";
import { createArmWave, createFingerRipple } from "../src/motion/dexterity";
import type { Axis, MotionProgram, Timeline } from "../src/motion/types";

function value(
  timeline: Timeline,
  time: number,
  target: string,
  axis: Axis,
): number {
  return (
    sampleTimeline(timeline, time).find(
      (v) => v.target === target && v.axis === axis && v.channel === "rotation",
    )?.value ?? 0
  );
}

function peakTime(
  timeline: Timeline,
  target: string,
  axis: Axis,
  cycle: number,
): number {
  const baseline = value(timeline, 0, target, axis);
  let peak = 0,
    maximum = 0;
  for (let i = 0; i <= 1200; i++) {
    const time = (cycle * i) / 1200;
    const amount = Math.abs(value(timeline, time, target, axis) - baseline);
    if (amount > maximum) {
      maximum = amount;
      peak = time;
    }
  }
  expect(
    maximum,
    `${target}.${axis} should visibly articulate`,
  ).toBeGreaterThan(4.9);
  return peak;
}

test("finger ripple crosses all five fingers in the requested order on either hand", () => {
  for (const side of ["left", "right"] as const) {
    for (const reverse of [false, true]) {
      const program = createFingerRipple(side, reverse);
      const timeline = compileMotion(program),
        cycle = timeline.duration / 2;
      const order = ["pinky", "ring", "middle", "index", "thumb"];
      if (reverse) order.reverse();
      const peaks = order.map((finger) =>
        peakTime(timeline, `${side}_${finger}_1`, "z", cycle),
      );
      for (let i = 1; i < peaks.length; i++)
        expect(peaks[i] - peaks[i - 1]).toBeGreaterThan(cycle * 0.1);
      for (const finger of order) {
        const segments = [1, 2, 3].map((segment) =>
          peakTime(timeline, `${side}_${finger}_${segment}`, "z", cycle),
        );
        expect(segments[1]).toBeGreaterThan(segments[0]);
        expect(segments[2]).toBeGreaterThan(segments[1]);
        for (const peak of segments) {
          const signedCurl = value(timeline, peak, `${side}_${finger}_1`, "z");
          expect(signedCurl * (side === "left" ? 1 : -1)).toBeGreaterThan(0);
        }
      }
    }
  }
});

test("arm wave propagates fingertips through the entire arm chain and reverses its timing", () => {
  const order = [
    "left_index_3",
    "left_wrist",
    "left_elbow",
    "left_shoulder",
    "left_clavicle",
    "chest",
    "right_clavicle",
    "right_shoulder",
    "right_elbow",
    "right_wrist",
    "right_index_3",
  ];
  const forward = compileMotion(createArmWave(false)),
    backward = compileMotion(createArmWave(true));
  const cycle = forward.duration / 2;
  const peaks = order.map((target) => peakTime(forward, target, "z", cycle));
  for (let i = 1; i < peaks.length; i++)
    expect(peaks[i], order[i]).toBeGreaterThan(peaks[i - 1]);
  const reversedPeaks = [...order]
    .reverse()
    .map((target) => peakTime(backward, target, "z", cycle));
  for (let i = 1; i < reversedPeaks.length; i++)
    expect(reversedPeaks[i]).toBeGreaterThan(reversedPeaks[i - 1]);
  // All channels reverse within the performed gesture, which precedes a
  // quiet pause. Merely flipping labels or signs cannot satisfy this check.
  const summedTimes = order.map(
    (target, i) => peaks[i] + peakTime(backward, target, "z", cycle),
  );
  for (const sum of summedTimes) expect(sum).toBeCloseTo(summedTimes[0], 2);
});

test("dexterity gestures are continuous across every key, settle interval, and repeated cycle", () => {
  const programs: MotionProgram[] = [
    createFingerRipple("left"),
    createFingerRipple("right", true),
    createArmWave(),
    createArmWave(true),
  ];
  for (const program of programs) {
    const timeline = compileMotion(program),
      epsilon = 1e-5;
    const boundaries = new Set([0, timeline.duration / 2, timeline.duration]);
    for (const track of timeline.tracks) {
      boundaries.add(track.start);
      boundaries.add(track.start + track.duration);
      if (track.curve.kind === "keys")
        for (const [phase] of track.curve.points)
          boundaries.add(track.start + phase * track.duration);
    }
    const pose = (time: number) =>
      new Map(
        sampleTimeline(timeline, time).map((v) => [
          `${v.target}.${v.channel}.${v.axis}`,
          v.value,
        ]),
      );
    for (const time of boundaries) {
      const before = pose(Math.max(0, time - epsilon)),
        after = pose(Math.min(timeline.duration, time + epsilon));
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        expect(
          Math.abs((before.get(key) ?? 0) - (after.get(key) ?? 0)),
          `${program.title}: ${key} at ${time}`,
        ).toBeLessThan(0.01);
      }
    }
    const start = pose(0),
      end = pose(timeline.duration);
    for (const key of new Set([...start.keys(), ...end.keys()]))
      expect(end.get(key) ?? 0).toBeCloseTo(start.get(key) ?? 0, 10);
  }
});
