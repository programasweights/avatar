import { compileMotion, findNode, sampleCurve } from "../src/motion/engine";
import {
  changeGangnamSupport,
  createGangnam,
  GANGNAM_BPM,
} from "../src/motion/gangnam";
import type { GangnamSupport } from "../src/motion/gangnam";
import type { Curve, CurveNode, MotionNode, MotionProgram, Timeline } from "../src/motion/types";

const BEAT = 60 / GANGNAM_BPM;
const CYCLE = 16 * BEAT;
const DURATION = 20 * BEAT;
const PHASE = 0.3 * BEAT;
const BLEND = 0.3;
const EPSILON = 1e-10;

export interface GangnamLaunchInputs {
  both?: MotionProgram;
  left?: MotionProgram;
  right?: MotionProgram;
}

/** Global source time keeps the arms and groove running through both edits. */
export function gangnamLaunchSourceTime(time: number): number {
  return (Math.max(0, Math.min(DURATION, time)) + PHASE) % CYCLE;
}

type Window = { start: number; end: number; from: GangnamSupport; to?: GangnamSupport };
const edits = [
  { support: "left" as const, beat: 4, start: 4 * BEAT, settled: 4 * BEAT + BLEND },
  { support: "right" as const, beat: 10, start: 10 * BEAT, settled: 10 * BEAT + BLEND },
];
const windows: Window[] = [
  { start: 0, end: edits[0].start, from: "both" },
  { start: edits[0].start, end: edits[0].settled, from: "both", to: "left" },
  { start: edits[0].settled, end: edits[1].start, from: "left" },
  { start: edits[1].start, end: edits[1].settled, from: "left", to: "right" },
  { start: edits[1].settled, end: DURATION, from: "right" },
];

function isSupportTrack(track: Timeline["tracks"][number]): boolean {
  return track.ancestors.includes("feet") || track.ancestors.includes("balance");
}

function checkInput(program: MotionProgram, support: GangnamSupport): Timeline {
  const timeline = compileMotion(program);
  if (program.dance?.style !== "gangnam" || program.dance.support !== support ||
    program.bpm !== GANGNAM_BPM || Math.abs(timeline.duration - CYCLE) > EPSILON)
    throw new Error(`Expected a 16-beat, 132 BPM Gangnam program with ${support} support.`);
  if (timeline.contacts?.length || timeline.props?.length ||
    timeline.tracks.some((track) => Math.abs(track.start) > EPSILON ||
      Math.abs(track.duration - CYCLE) > EPSILON))
    throw new Error("The launch accepts one complete cycle of joint curves, without props or contacts.");
  for (const id of ["feet", "balance"])
    if (!findNode(program.root, id)) throw new Error(`Missing editable ${id} branch.`);
  for (const track of timeline.tracks)
    if (Math.abs(sampleCurve(track.curve, 0) - sampleCurve(track.curve, 1)) > 1e-6)
      throw new Error(`The source cycle does not close at ${track.id}.`);
  return timeline;
}

// Keep source knots exactly. Extra samples are only needed for the short
// support blend or for a cropped smooth curve supplied by a caller.
function pointsBetween(curve: Curve, from: number, to: number, dense = false): number[] {
  const times = [from, to];
  if (curve.kind === "keys")
    for (const [time] of curve.points)
      if (time > from + EPSILON && time < to - EPSILON) times.push(time);
  if (dense) {
    const steps = Math.max(1, Math.ceil((to - from) * CYCLE * 120));
    for (let i = 1; i < steps; i++) times.push(from + (to - from) * i / steps);
  }
  return times.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > EPSILON);
}

function cropCurve(curve: Curve, from: number, to: number): Curve {
  if (curve.kind === "constant") return { ...curve };
  if (curve.kind === "sine") return {
    ...curve,
    cycles: curve.cycles * (to - from),
    phase: (curve.phase ?? 0) + curve.cycles * from,
  };
  const smooth = curve.interpolation === undefined || curve.interpolation === "smooth";
  return {
    kind: "keys",
    interpolation: smooth ? "linear" : curve.interpolation,
    points: pointsBetween(curve, from, to, smooth).map((p) => [
      (p - from) / (to - from), sampleCurve(curve, p),
    ]),
  };
}

function blendCurve(a: Curve, b: Curve, from: number, to: number): Curve {
  const times = [...pointsBetween(a, from, to, true), ...pointsBetween(b, from, to)];
  times.sort((x, y) => x - y);
  return {
    kind: "keys", interpolation: "linear",
    points: times.filter((t, i) => i === 0 || t - times[i - 1] > EPSILON).map((p) => {
      const x = (p - from) / (to - from);
      // Zero slope and acceleration at either end avoid a support-change snap.
      const weight = x * x * x * (x * (x * 6 - 15) + 10);
      const value = sampleCurve(a, p);
      return [x, value + (sampleCurve(b, p) - value) * weight];
    }),
  };
}

function curveSegments(node: CurveNode, schedule: Window[], variants: Record<GangnamSupport, MotionProgram>): MotionNode {
  const children: CurveNode[] = [];
  for (const window of schedule) {
    let start = window.start;
    while (start < window.end - EPSILON) {
      const cycleIndex = Math.floor((start + PHASE + EPSILON) / CYCLE);
      const end = Math.min(window.end, (cycleIndex + 1) * CYCLE - PHASE);
      const from = Math.max(0, (start + PHASE) / CYCLE - cycleIndex);
      const to = Math.min(1, (end + PHASE) / CYCLE - cycleIndex);
      const source = findNode(variants[window.from].root, node.id) as CurveNode;
      const destination = window.to ? findNode(variants[window.to].root, node.id) as CurveNode : undefined;
      const curve = destination ? blendCurve(source.curve, destination.curve, from, to) : cropCurve(source.curve, from, to);
      // The editable format permits 256 keys per leaf; dense imported smooth
      // curves can be divided without changing the sampled interpolation.
      if (curve.kind === "keys" && curve.points.length > 256) {
        for (let first = 0; first < curve.points.length - 1; first += 255) {
          const points = curve.points.slice(first, first + 256);
          const low = points[0][0], high = points.at(-1)![0];
          children.push({ ...node, id: `${node.id}.launch.${children.length}`, duration: (end - start) * (high - low),
            curve: { ...curve, points: points.map(([p, v]) => [(p - low) / (high - low), v]) } });
        }
      } else children.push({ ...node, id: `${node.id}.launch.${children.length}`, duration: end - start, curve });
      start = end;
    }
  }
  return { id: node.id, label: node.label, kind: "sequence", children };
}

/**
 * An editable 20-beat launch cut, derived from the same three programs used by
 * the studio. Pass captured remote results to render the actual command output.
 * This cut ends on right support; it is deliberately not a seamless loop.
 */
export function createGangnamLaunch(input: GangnamLaunchInputs = {}) {
  const both = input.both ?? createGangnam();
  const left = input.left ?? changeGangnamSupport(both, "left");
  const right = input.right ?? changeGangnamSupport(left, "right");
  const variants = { both, left, right };
  const timelines = {
    both: checkInput(both, "both"),
    left: checkInput(left, "left"),
    right: checkInput(right, "right"),
  };
  const upperBody = (timeline: Timeline) => JSON.stringify(timeline.tracks.filter((t) => !isSupportTrack(t)).map(
    ({ target, axis, channel, curve, blend }) => ({ target, axis, channel, curve, blend }),
  ));
  for (const side of ["left", "right"] as const) {
    if (upperBody(timelines[side]) !== upperBody(timelines.both))
      throw new Error("Support edits must preserve the supplied upper body; the launch cannot hide unrelated changes.");
    const expected = timelines.both.tracks.filter(isSupportTrack);
    if (timelines[side].tracks.filter(isSupportTrack).length !== expected.length)
      throw new Error(`The ${side} program has different support channels.`);
    for (const track of expected) {
      const other = findNode(variants[side].root, track.id);
      if (other?.kind !== "curve" || other.target !== track.target || other.axis !== track.axis ||
        other.channel !== track.channel || other.blend !== track.blend)
        throw new Error(`The ${side} program has no matching support channel for ${track.id}.`);
    }
  }
  const supportIds = new Set(timelines.both.tracks.filter(isSupportTrack).map((t) => t.id));
  const visit = (node: MotionNode): MotionNode => {
    if (node.kind === "contact") throw new Error("Unexpected contact in a joint-curve launch.");
    if (node.kind === "curve") return curveSegments(node, supportIds.has(node.id) ? windows : [
      { start: 0, end: DURATION, from: "both" },
    ], variants);
    return { ...node, children: node.children.map(visit) };
  };
  const program: MotionProgram = {
    version: 2, bpm: GANGNAM_BPM,
    title: "Gangnam Style · left foot → right foot",
    root: { ...visit(both.root), label: "Keep dancing · change the support foot" },
  };
  compileMotion(program);
  return {
    program,
    cues: [
      { start: 0, duration: edits[0].start, instruction: "Dance Gangnam Style." },
      { start: edits[0].start, duration: edits[1].start - edits[0].start, instruction: "Now on one foot." },
      { start: edits[1].start, duration: DURATION - edits[1].start, instruction: "Switch to the opposite foot." },
    ],
    launch: {
      duration: DURATION, bpm: GANGNAM_BPM, beats: 20,
      phaseOffsetBeats: 0.3, sourceDuration: CYCLE, blendDuration: BLEND,
      initialSupport: "both" as const, finalSupport: "right" as const,
      edits: edits.map((edit) => ({ ...edit })),
    },
  };
}
