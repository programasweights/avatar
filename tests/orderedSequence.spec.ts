import { expect, test } from "@playwright/test";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { compileMotion, findNode, sampleContacts, sampleTimeline } from "../src/motion/engine";
import { createDance } from "../src/motion/skills";
import { changeGangnamSupport, createGangnam } from "../src/motion/gangnam";
import { getOrderedSequenceCues, parseOrderedSequence, type OrderedStep } from "../src/motion/orderedSequence";
import type { MotionProgram, PoseValue } from "../src/motion/types";

const neutral = () => createDance("idle", "still");
const envelope = (commands: string[], overrides: Partial<OrderedStep>[] = []) => JSON.stringify({ kind: "sequence", steps: commands.map((command, index) => ({ instruction: `Step ${index + 1}`, commands: command, mode: "perform", ...overrides[index] })) });
const pose = (program: MotionProgram, time: number) => sampleTimeline(compileMotion(program), time);
const value = (values: PoseValue[], target: string, axis: string, channel = "rotation") => values.find(value => value.target === target && value.axis === axis && value.channel === channel)?.value ?? 0;
const interiors = (program: MotionProgram) => getOrderedSequenceCues(program).map(cue => cue.start + cue.duration * .7);

test("ordered joint phases retain every step without accumulating opposite angles or executing simultaneously", () => {
  const original = applyCommands(neutral(), "dance salsa"), saved = JSON.stringify(original);
  const sequence = applyCommands(original, envelope(["joint head y 30", "joint head y -30", "joint left_shoulder z 50"]));
  const cues = getOrderedSequenceCues(sequence), times = interiors(sequence);
  expect(compileMotion(sequence).duration).toBeCloseTo(6, 9);
  expect(cues.map(cue => cue.duration)).toEqual([2, 2, 2]);
  expect(value(pose(sequence, times[0]), "head", "y")).toBe(30);
  expect(value(pose(sequence, times[1]), "head", "y")).toBe(-30);
  expect(value(pose(sequence, times[2]), "head", "y")).toBe(-30);
  expect(value(pose(sequence, times[0]), "left_shoulder", "z")).toBe(0);
  expect(value(pose(sequence, times[2]), "left_shoulder", "z")).toBe(50);
  expect(value(pose(sequence, times[0]), "hips", "y")).toBe(0);
  expect(JSON.stringify(original)).toBe(saved);
});

test("cross-domain choreography preserves dance phases, body counts, skill contacts, and stage-local modifiers", () => {
  const sequence = applyCommands(neutral(), envelope([
    "dance salsa\narms still", "action jump 2", "skill finger_touches left forward", "dance robot",
  ]));
  const timeline = validateRigProgram(sequence), cues = getOrderedSequenceCues(sequence);
  expect(cues).toHaveLength(4);
  expect(cues[0].duration).toBeCloseTo(4, 9);
  expect(cues[3].duration).toBeCloseTo(4, 9);
  expect(value(pose(sequence, 1.2), "left_shoulder", "x")).toBe(0);
  expect(value(pose(sequence, 1.2), "hips", "y")).not.toBe(0);
  const flight = Array.from({ length: 160 }, (_, index) => value(pose(sequence, cues[1].start + cues[1].duration * index / 160), "root", "y", "position") > .1);
  expect(flight.filter((flying, index) => flying && !flight[index - 1])).toHaveLength(2);
  const contacts = timeline.contacts?.filter(contact => contact.mode === "fingertips") ?? [];
  expect(new Set(contacts.map(contact => contact.mode === "fingertips" && contact.target)).size).toBe(4);
  expect(contacts.every(contact => contact.start >= cues[2].start && contact.start + contact.duration <= cues[3].start + 1e-8)).toBe(true);
  expect(sampleContacts(timeline, cues[0].start + 1)).toEqual([]);
  expect(sampleContacts(timeline, cues[3].start + 1)).toEqual([]);
  expect(value(pose(sequence, cues[3].start + 1), "left_shoulder", "x")).not.toBe(0);
});

test("performing a wave after a jump holds the landing instead of replaying the jump", () => {
  const sequence = applyCommands(neutral(), envelope(["action jump 2", "wave right"]));
  const cues = getOrderedSequenceCues(sequence);
  const heights = [.25, .4, .6, .8, .95].map(fraction => value(pose(sequence, cues[1].start + cues[1].duration * fraction), "root", "y", "position"));
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1e-10);
  const wrists = [.25, .4, .6, .8].map(fraction => value(pose(sequence, cues[1].start + cues[1].duration * fraction), "right_wrist", "z"));
  expect(Math.max(...wrists) - Math.min(...wrists)).toBeGreaterThan(10);
});

test("continue resolves relative controls against the prior phase while independent future steps cannot change it", () => {
  const sequence = applyCommands(neutral(), envelope([
    "skill finger_ripple left forward", "reverse current", "hand other",
  ], [{ seconds: 3 }, { mode: "continue", seconds: 3 }, { mode: "continue", seconds: 3 }]));
  const timeline = validateRigProgram(sequence), cues = getOrderedSequenceCues(sequence);
  expect(timeline.duration).toBeCloseTo(9, 9);
  for (const [index, cue] of cues.entries()) {
    const tracks = timeline.tracks.filter(track => track.start >= cue.start + .28 - 1e-8 && track.start < cue.start + cue.duration - 1e-8 && /_(pinky|thumb)_1$/.test(track.target));
    expect(tracks.some(track => track.target.startsWith(index === 2 ? "right_" : "left_"))).toBe(true);
  }
  // The first pass is unchanged even when the second one reverses it.
  const baseline = applyCommands(neutral(), envelope(["skill finger_ripple left forward", "joint head y 20"], [{ seconds: 3 }, {}]));
  for (const time of [.6, 1.1, 1.9, 2.7]) expect(pose(sequence, time)).toEqual(pose(baseline, time));
});

test("turns carry their heading into later dances and skills without modifying local foot timing", () => {
  const sequence = applyCommands(neutral(), envelope(["action turn_left 1", "dance salsa", "skill finger_ripple right forward"]));
  const cues = getOrderedSequenceCues(sequence);
  for (const cue of cues.slice(1)) for (const fraction of [.2, .5, .9])
    expect(value(pose(sequence, cue.start + cue.duration * fraction), "root", "y")).toBeCloseTo(90, 8);
});

test("seconds crop real-time dance playback and support edits continue the same arm clock", () => {
  const native = createGangnam(), nativeTimeline = compileMotion(native);
  const sequence = applyCommands(neutral(), envelope(["dance gangnam", "support left", "support other"], [
    { seconds: 3 }, { mode: "continue", seconds: 3 }, { mode: "continue", seconds: 3 },
  ]));
  const cues = getOrderedSequenceCues(sequence);
  expect(cues.map(cue => cue.start)).toEqual([0, 3, 6]);
  expect(compileMotion(sequence).duration).toBeCloseTo(9, 10);
  const sources = [native, changeGangnamSupport(native, "left"), changeGangnamSupport(native, "right")];
  for (let index = 0; index < 3; index++) for (const elapsed of [.4, .73, 1.37, 2.31, 2.9]) {
    const time = index * 3 + elapsed;
    const expected = pose(sources[index], time % nativeTimeline.duration), actual = pose(sequence, time);
    for (const channel of expected.filter(channel => /_(shoulder|elbow|wrist)$/.test(channel.target)))
      expect(value(actual, channel.target, channel.axis, channel.channel), `${key(channel)} at ${time}`).toBeCloseTo(channel.value, 2);
  }
  for (const boundary of [3, 6]) for (const offset of [-.001, 0, .001, .1, .25]) {
    const time = boundary + offset, expected = pose(native, time % nativeTimeline.duration), actual = pose(sequence, time);
    for (const channel of expected.filter(channel => /_(shoulder|elbow|wrist)$/.test(channel.target)))
      expect(Math.abs(value(actual, channel.target, channel.axis, channel.channel) - channel.value)).toBeLessThan(.015);
  }
});

test("coin lifetimes and editable contact subtrees survive ordered phases and later tempo or arm edits", () => {
  const sequence = applyCommands(neutral(), envelope(["skill coin_roll left forward", "joint head y 20", "skill coin_roll right reverse"], [{ seconds: 4 }, {}, { seconds: 4 }]));
  const cues = getOrderedSequenceCues(sequence), timeline = validateRigProgram(sequence);
  expect(sequence.props).toHaveLength(1);
  expect(sampleContacts(timeline, 0).filter(contact => contact.mode === "prop_transfer")).toHaveLength(0);
  expect(sampleContacts(timeline, .27).filter(contact => contact.mode === "prop_transfer")).toHaveLength(1);
  expect(sampleContacts(timeline, cues[1].start + .1).filter(contact => contact.mode === "prop_transfer")).toHaveLength(1);
  expect(sampleContacts(timeline, cues[1].start + .2)).toHaveLength(0);
  expect(sampleContacts(timeline, cues[2].start + .27).some(contact => contact.mode === "prop_transfer" && contact.from.startsWith("right_"))).toBe(true);
  expect(findNode(sequence.root, "arms")?.kind).toBe("parallel");
  expect(findNode(sequence.root, "details")?.kind).toBe("parallel");
  const slower = applyCommands(sequence, "tempo 54");
  expect(getOrderedSequenceCues(slower).map(cue => cue.start)).toEqual(cues.map(cue => cue.start * 2));
  const joint = applyCommands(sequence, "joint head y 10");
  const edited = value(pose(joint, .8), "head", "y");
  expect(edited).toBeCloseTo(value(pose(sequence, .8), "head", "y") + 10, 9);
  const still = applyCommands(sequence, "arms still");
  expect(compileMotion(still).duration).toBeCloseTo(timeline.duration, 9);
  expect(value(pose(still, .8), "left_shoulder", "x")).toBe(0);
  expect(getOrderedSequenceCues(still)).toHaveLength(3);
  const reversed = applyCommands(sequence, "reverse current");
  expect(getOrderedSequenceCues(reversed).map(cue => cue.instruction)).toEqual([...cues].reverse().map(cue => cue.instruction));
  for (const time of [.45, 1.6, 3.4, 4.7, 7.3, 9.6]) {
    const actual = pose(reversed, timeline.duration - time);
    for (const channel of pose(sequence, time)) expect(value(actual, channel.target, channel.axis, channel.channel)).toBeCloseTo(channel.value, 6);
  }
});

test("short clipped fingertip studies have strictly increasing normalized keyframes", () => {
  const sequence = applyCommands(neutral(), envelope(["skill finger_ripple left forward", "skill finger_touches left forward"], [{ seconds: 2 }, { seconds: 2 }]));
  const timeline = validateRigProgram(sequence);
  expect(timeline.duration).toBeCloseTo(4, 9);
  for (const track of timeline.tracks) if (track.curve.kind === "keys") {
    const times = track.curve.points.map(([time]) => time);
    expect(times.every((time, index) => time >= 0 && time <= 1 && (!index || time > times[index - 1]))).toBe(true);
  }
});

test("phase transitions are continuous for every represented channel and explicit durations remain exact", () => {
  const sequence = applyCommands(neutral(), envelope(["joint left_shoulder z 70", "action walk 1", "dance salsa", "skill finger_ripple right forward"], [{ seconds: 1 }, { seconds: 2 }, { seconds: 3 }, { seconds: 4 }]));
  const timeline = compileMotion(sequence), cues = getOrderedSequenceCues(sequence);
  expect(timeline.duration).toBeCloseTo(10, 9);
  expect(cues.map(cue => cue.duration)).toEqual([1, 2, 3, 4]);
  const boundaries = cues.slice(1).map(cue => cue.start).concat(cues.map(cue => cue.start + .28));
  for (const boundary of boundaries) {
    const a = new Map(pose(sequence, boundary - 1e-7).map(value => [key(value), value.value]));
    const b = new Map(pose(sequence, boundary + 1e-7).map(value => [key(value), value.value]));
    for (const channel of new Set([...a.keys(), ...b.keys()])) expect(Math.abs((a.get(channel) ?? 0) - (b.get(channel) ?? 0)), `${channel} at ${boundary}`).toBeLessThan(.001);
  }
});

const key = (value: PoseValue) => `${value.target}.${value.channel}.${value.axis}`;

test("malformed or unsupported plans fail atomically and legacy multiline blocks retain their original meaning", () => {
  const current = applyCommands(neutral(), "dance salsa"), saved = JSON.stringify(current);
  const invalid = [
    "{oops", JSON.stringify({ kind: "parallel", steps: [] }), envelope(["dance salsa"]),
    envelope(["action jump 1", "unsupported"]), envelope(["dance salsa", "playback pause"]),
    envelope(["dance salsa", "freeze left_thumb"]), envelope(["dance salsa", "dance mystery"]),
    envelope(["dance salsa", "joint head y 20"], [{ seconds: 0 }, {}]),
    envelope(["dance salsa", "joint head y 20"], [{ seconds: 13 }, {}]),
    envelope(["action jump 2", "dance salsa"], [{ seconds: 1 }, {}]),
    envelope(["dance salsa\ndance robot", "joint head y 20"]),
    envelope(["action spin 8", "action spin 8", "action spin 8", "action spin 8"]),
  ];
  for (const raw of invalid) { expect(() => applyCommands(current, raw)).toThrow(); expect(JSON.stringify(current)).toBe(saved); }
  expect(parseOrderedSequence("joint head y 20")).toBeUndefined();
  for (const metadata of [null, {}, { cues: 3 }, { cues: [null, null] }, { cues: [{ id: 4 }, { id: 5 }] }])
    expect(getOrderedSequenceCues({ ...current, orderedSequence: metadata } as MotionProgram)).toEqual([]);
  const legacy = applyCommands(neutral(), "joint head y 20\njoint left_shoulder z 40");
  expect(getOrderedSequenceCues(legacy)).toEqual([]);
  expect(value(pose(legacy, .8), "head", "y")).toBe(20);
  expect(value(pose(legacy, .8), "left_shoulder", "z")).toBe(40);
});
