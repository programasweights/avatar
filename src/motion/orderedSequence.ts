import { compileMotion, findNode, sampleContacts, sampleCurve, sampleTimeline } from "./engine";
import { createDexterity } from "./dexterityDirector";
import { createDance } from "./skills";
import { createPostureRecovery } from "./bodyActions";
import type { DexteritySkill } from "./dexterity";
import type { ContactNode, ContactValue, Curve, CurveNode, GroupNode, MotionNode, MotionProgram, MotionProp, PoseValue } from "./types";

export interface OrderedStep {
  instruction: string;
  commands: string;
  mode: "perform" | "continue";
  seconds?: number;
}
export interface OrderedPlan { kind: "sequence"; steps: OrderedStep[] }
export interface OrderedCue {
  id: string;
  label: string;
  instruction: string;
  start: number;
  duration: number;
}
type OrderedProgram = MotionProgram & { orderedSequence?: { cues: Omit<OrderedCue, "start" | "duration">[] } };
type AtomicApply = (current: MotionProgram, commands: string) => MotionProgram;
type Lane = "body" | "arms" | "details";
const group = (id: string, label: string, children: MotionNode[], kind: GroupNode["kind"] = "parallel"): GroupNode => ({ id, label, kind, children });
const constant = (value: number): Curve => ({ kind: "constant", value });
const key = (value: PoseValue) => `${value.target}.${value.channel}.${value.axis}`;
const armTarget = (target: string) => /^(left|right)_(clavicle|shoulder|elbow|wrist|thumb|index|middle|ring|pinky)(_|$)/.test(target);

/** An explicit envelope is the only thing that changes legacy command ordering. */
export function parseOrderedSequence(raw: string): OrderedPlan | undefined {
  if (!raw.trim().startsWith("{")) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("PAW returned invalid sequence JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ordered motion plan.");
  const plan = value as Record<string, unknown>;
  if (plan.kind !== "sequence" || Object.keys(plan).some(name => !["kind", "steps"].includes(name)) || !Array.isArray(plan.steps) || plan.steps.length < 2 || plan.steps.length > 4)
    throw new Error("An ordered motion needs two to four steps.");
  const steps = plan.steps.map((entry): OrderedStep => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid ordered motion step.");
    const step = entry as Record<string, unknown>;
    if (Object.keys(step).some(name => !["instruction", "commands", "mode", "seconds"].includes(name)) ||
      typeof step.instruction !== "string" || !step.instruction.trim() || step.instruction.length > 400 ||
      typeof step.commands !== "string" || !step.commands.trim() || step.commands.length > 1500 ||
      !["perform", "continue"].includes(step.mode as string)) throw new Error("Invalid ordered motion step.");
    const commands = step.commands.trim();
    const lines = commands.split("\n").map(line => line.trim());
    if (lines.length > 12 || lines.some(line => !line || /^(unsupported|playback|freeze|restore)(\s|$)/.test(line)) || commands.startsWith("{"))
      throw new Error("A timed sequence requires supported motion commands, without playback or editor controls.");
    const starters = lines.filter(line => /^(dance|skill|action) /.test(line));
    if (starters.length > 1 && !starters.every(line => /^action /.test(line)))
      throw new Error("Keep distinct new motions in separate sequence steps.");
    if (step.seconds !== undefined && (typeof step.seconds !== "number" || !Number.isFinite(step.seconds) || step.seconds < 1 || step.seconds > 12))
      throw new Error("Each timed step must last between one and twelve seconds.");
    return { instruction: step.instruction.trim(), commands, mode: step.mode as OrderedStep["mode"], ...(step.seconds === undefined ? {} : { seconds: step.seconds as number }) };
  });
  return { kind: "sequence", steps };
}

function duration(node: MotionNode): number {
  if (node.kind === "curve" || node.kind === "contact") return node.duration;
  const children = node.children.map(duration);
  return node.kind === "parallel" ? Math.max(...children) : children.reduce((a, b) => a + b, 0) * (node.kind === "repeat" ? node.count! : 1);
}
function slicedCurve(curve: Curve, start: number, end: number): Curve {
  if (curve.kind === "constant") return curve;
  if (curve.kind === "sine") return { ...curve, cycles: curve.cycles * (end - start), phase: (curve.phase ?? 0) + curve.cycles * start };
  const atKey = (time: number) => curve.points.some(([point]) => Math.abs(point - time) < 1e-10);
  const normalize = (time: number) => Math.max(0, Math.min(1, (time - start) / (end - start)));
  if ((atKey(start) || start === 0) && (atKey(end) || end === 1)) return { ...curve, points: [
    [0, sampleCurve(curve, start)], ...curve.points.filter(([time]) => time > start + 1e-10 && time < end - 1e-10).map(([time, value]): [number, number] => [normalize(time), value]), [1, sampleCurve(curve, end)],
  ] };
  // Only clipped portions of a smooth key interval need approximation. Dense
  // linear keys preserve its original clock instead of restarting smoothstep.
  const times = [start, end, ...curve.points.map(([time]) => time).filter(time => time > start && time < end),
    ...Array.from({ length: 63 }, (_, index) => start + (end - start) * (index + 1) / 64)];
  // Source knots can coincide with a sampling point within floating-point
  // rounding. Deduplicate normalized times after clamping, including endpoints.
  const points = new Map(times.map(time => [Number(normalize(time).toFixed(12)), sampleCurve(curve, time)]));
  return { kind: "keys", interpolation: curve.interpolation === "hold" ? "hold" : "linear", points: [...points].sort(([a], [b]) => a - b) };
}
function curvePieces(node: CurveNode, start: number, end: number, id: string): MotionNode {
  if (node.curve.kind !== "keys" || node.curve.interpolation === "linear" || node.curve.interpolation === "hold")
    return { ...node, id, duration: (end - start) * node.duration, curve: slicedCurve(node.curve, start, end) };
  const interior = node.curve.points.map(([time]) => time).filter(time => time > start + 1e-10 && time < end - 1e-10);
  const cuts = [...new Set([start, ...(interior.length ? [interior[0], interior[interior.length - 1]] : []), end])].sort((a, b) => a - b);
  const pieces = cuts.slice(0, -1).map((a, index): CurveNode => ({ ...node, id: `${id}.curve.${index}`, duration: (cuts[index + 1] - a) * node.duration, curve: slicedCurve(node.curve, a, cuts[index + 1]) }));
  return pieces.length === 1 ? { ...pieces[0], id } : group(id, node.label, pieces, "sequence");
}
function windowProgram(program: MotionProgram, offset: number, seconds: number, contactStart: number): MotionProgram {
  const timeline = compileMotion(program), children: MotionNode[] = [];
  const attach = (node: MotionNode, start: number, id: string, detail: boolean) => {
    const ending = seconds - start - duration(node);
    const parts = [...(start > 1e-9 ? [wait(`${id}.delay`, start)] : []), node, ...(ending > 1e-9 ? [wait(`${id}.ending`, ending)] : [])];
    const aligned = parts.length > 1 ? group(`${id}.at`, node.label, parts, "sequence") : node;
    children.push(detail ? group(`detail.${id}`, node.label, [aligned]) : aligned);
  };
  const first = Math.floor(offset / timeline.duration), last = Math.ceil((offset + seconds) / timeline.duration);
  for (let cycle = first; cycle < last; cycle++) {
    const origin = cycle * timeline.duration - offset;
    timeline.tracks.forEach((track, index) => {
      const a = Math.max(0, origin + track.start), b = Math.min(seconds, origin + track.start + track.duration);
      if (b - a < 1e-9) return;
      const id = `window.${cycle}.${index}.${track.id}`;
      const node = curvePieces(track, Math.max(0, (a - origin - track.start) / track.duration), Math.min(1, (b - origin - track.start) / track.duration), id);
      attach(node, a, id, track.ancestors.includes("details") || track.ancestors.some(id => /^editing\./.test(id)));
    });
    (timeline.contacts ?? []).forEach((contact, index) => {
      const a = Math.max(contactStart, origin + contact.start), b = Math.min(seconds, origin + contact.start + contact.duration);
      if (b - a < 1e-9) return;
      const start = Math.max(0, (a - origin - contact.start) / contact.duration), end = Math.min(1, (b - origin - contact.start) / contact.duration), id = `window.contact.${cycle}.${index}`;
      const node: ContactNode = contact.mode === "fingertips"
        ? { ...contact, id, duration: b - a, weight: slicedCurve(contact.weight, start, end) }
        : { ...contact, id, duration: b - a, progress: slicedCurve(contact.progress, start, end), ...(contact.visibility ? { visibility: slicedCurve(contact.visibility, start, end) } : {}) };
      attach(node, a, id, true);
    });
  }
  children.push(wait("window.duration", seconds));
  return { ...program, root: group("window", program.title, children) };
}
function endpoint(program: MotionProgram): PoseValue[] {
  const timeline = compileMotion(program);
  return sampleTimeline(timeline, timeline.duration);
}
function holdPose(values: PoseValue[], bpm: number, seconds: number): MotionProgram {
  const lanes: Record<Lane, MotionNode[]> = { body: [], arms: [], details: [] };
  for (const value of values) {
    const lane: Lane = value.target.endsWith("_hand_camera") ? "details" : armTarget(value.target) ? "arms" : "body";
    lanes[lane].push({ id: `held.${key(value)}`, kind: "curve", label: `${value.target.replaceAll("_", " ")} · held`,
      target: value.target, axis: value.axis, channel: value.channel, duration: seconds, curve: constant(value.value) });
  }
  for (const lane of ["body", "arms", "details"] as const) if (!lanes[lane].length) lanes[lane].push(wait(`held.${lane}.wait`, seconds));
  return { version: 2, title: "Hold the preceding pose", bpm, root: group("motion", "Held pose", [
    group("body", "Body · held pose", lanes.body), group("arms", "Arms · held pose", lanes.arms), group("details", "Joint details", lanes.details),
  ]) };
}
function wait(id: string, seconds: number): CurveNode {
  return { id, label: "Keep this phase's timing", kind: "curve", target: "neck", channel: "rotation", axis: "x", duration: seconds, curve: constant(0) };
}
function affine(curve: Curve, amount: number, offset = 0): Curve {
  if (curve.kind === "constant") return constant(curve.value * amount + offset);
  if (curve.kind === "sine") return { ...curve, amplitude: curve.amplitude * amount, offset: (curve.offset ?? 0) * amount + offset };
  return { ...curve, points: curve.points.map(([time, value]) => [time, value * amount + offset]) };
}
// A newly constructed dance/action has a local heading of zero. Retain turns
// from earlier phases and rotate its stage-space sway into that facing.
function withFacing(program: MotionProgram, heading: number): MotionProgram {
  if (Math.abs(heading) < 1e-10) return program;
  const radians = heading * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  let hasYaw = false;
  const visit = (node: MotionNode): MotionNode => {
    if (node.kind === "contact") return node;
    if (node.kind !== "curve") return { ...node, children: node.children.map(visit) };
    if (node.target !== "root") return node;
    if (node.channel === "rotation" && node.axis === "y") { hasYaw = true; return { ...node, curve: affine(node.curve, 1, heading) }; }
    if (node.channel !== "position" || node.axis === "y") return node;
    return group(`${node.id}.heading`, node.label, [
      { ...node, id: `${node.id}.heading.x`, axis: "x", curve: affine(node.curve, node.axis === "x" ? cosine : sine) },
      { ...node, id: `${node.id}.heading.z`, axis: "z", curve: affine(node.curve, node.axis === "x" ? -sine : cosine) },
    ]);
  };
  let root = visit(program.root);
  if (!hasYaw) root = group("ordered_facing", program.title, [root, {
    id: "ordered_facing.yaw", label: "Keep the preceding heading", kind: "curve", target: "root", channel: "rotation", axis: "y", duration: compileMotion(program).duration, curve: constant(heading),
  }]);
  return { ...program, root };
}
function contactHold(contact: ContactValue, id: string, seconds: number, fadeIn: boolean): ContactNode {
  const fade: Curve = { kind: "keys", points: [[0, fadeIn ? 0 : 1], [1, fadeIn ? 1 : 0]], interpolation: "smooth" };
  if (contact.mode === "fingertips") return { id, label: "Release fingertip contact", kind: "contact", mode: contact.mode,
    effector: contact.effector, target: contact.target, duration: seconds, weight: affine(fade, contact.weight) };
  return { id, label: fadeIn ? "Introduce the next prop" : "Release the preceding prop", kind: "contact", mode: contact.mode,
    prop: contact.prop, from: contact.from, to: contact.to, duration: seconds, progress: constant(contact.progress), rolls: contact.rolls,
    rollOffset: contact.rollOffset, visibility: affine(fade, contact.visibility ?? 1) };
}
function transition(from: MotionProgram, to: MotionProgram, offset: number, id: string, seconds: number): GroupNode {
  const previous = compileMotion(from), next = compileMotion(to);
  const a = new Map(sampleTimeline(previous, previous.duration).map(value => [key(value), value]));
  const b = new Map(sampleTimeline(next, offset % next.duration).map(value => [key(value), value]));
  const children: MotionNode[] = [...new Set([...a.keys(), ...b.keys()])].map(channel => {
    const reference = b.get(channel) ?? a.get(channel)!;
    return { id: `${id}.${channel}`, label: `${reference.target.replaceAll("_", " ")} · transition`, kind: "curve",
      target: reference.target, channel: reference.channel, axis: reference.axis, duration: seconds,
      curve: { kind: "keys", interpolation: "smooth", points: [[0, (a.get(channel)?.value ?? 0) - (b.get(channel)?.value ?? 0)], [1, 0]] } };
  });
  const outgoing = sampleContacts(previous, previous.duration).filter(contact => contact.mode === "prop_transfer" || contact.weight > 0);
  const incoming = sampleContacts(next, (offset + seconds) % next.duration).filter(contact => contact.mode === "prop_transfer" || contact.weight > 0);
  // Separate half intervals retain single ownership even when both phases use
  // the same coin. The prop follows real hand anchors while it fades.
  if (outgoing.length || incoming.length) children.push(group(`${id}.contacts`, "Release → introduce contacts", [
    group(`${id}.release`, "Release previous contacts", outgoing.length ? outgoing.map((contact, index) => contactHold(contact, `${id}.release.${index}`, seconds / 2, false)) : [wait(`${id}.release.wait`, seconds / 2)]),
    group(`${id}.introduce`, "Introduce next contacts", incoming.length ? incoming.map((contact, index) => contactHold(contact, `${id}.introduce.${index}`, seconds / 2, true)) : [wait(`${id}.introduce.wait`, seconds / 2)]),
  ], "sequence"));
  return group(id, "Settle while the motion clock continues", children);
}

// Split each phase without flattening its keys, repeats, or contact nodes. Empty
// branches keep time so arm replacement and joint edits span the whole sequence.
function laneTree(node: MotionNode, lane: Lane, prefix: string, detail = false): MotionNode {
  const visit = (value: MotionNode, isDetail: boolean): MotionNode | undefined => {
    isDetail ||= value.id === "details" || /^detail\.|^editing\./.test(value.id);
    const id = `${prefix}.${value.id}`;
    if (value.kind === "curve" || value.kind === "contact") {
      const owner: Lane = isDetail || value.kind === "contact" || value.target.endsWith("_hand_camera") ? "details" : armTarget(value.target) ? "arms" : "body";
      return lane === owner ? { ...value, id } : undefined;
    }
    const children = value.children.map(child => visit(child, isDetail));
    if (children.every(child => !child)) return undefined;
    if (value.kind === "parallel") {
      const kept = children.filter((child): child is MotionNode => !!child);
      if (Math.max(...kept.map(duration)) < duration(value) - 1e-8) kept.push(wait(`${id}.padding`, duration(value)));
      return { ...value, id, children: kept };
    }
    return { ...value, id, children: children.map((child, index) => child ?? wait(`${id}.wait.${index}`, duration(value.children[index]))) };
  };
  return visit(node, detail) ?? wait(`${prefix}.wait`, duration(node));
}

/** Lower validated command blocks to one editable, contact-aware timeline. */
export function composeOrderedSequence(current: MotionProgram, plan: OrderedPlan, applyAtomic: AtomicApply): { program: MotionProgram; cues: OrderedCue[] } {
  plan = parseOrderedSequence(JSON.stringify(plan))!;
  compileMotion(current);
  const neutral = createDance("idle", "still", current.bpm);
  let previous = neutral;
  let previousTemplate = neutral;
  let playhead = 0;
  const phaseRoots: GroupNode[] = [];
  const props = new Map<string, MotionProp>();
  const metadata: Omit<OrderedCue, "start" | "duration">[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const lines = step.commands.split("\n").map(line => line.trim());
    const activePrevious = index === 0 && step.mode === "continue" ? current : previous;
    const before = endpoint(activePrevious);
    const skill = lines.find(line => /^skill /.test(line))?.split(/\s+/);
    const baseSeconds = skill && skill.length === 4 && ["finger_ripple", "finger_touches", "arm_wave", "coin_roll"].includes(skill[1]) && ["left", "right"].includes(skill[2])
      ? compileMotion(createDexterity(skill[1] as DexteritySkill, skill[2] as "left" | "right", skill[3] === "reverse", activePrevious.bpm)).duration : 2;
    // A new absolute joint direction replaces that channel's held value. Other
    // held joints persist; adding the requested angle to the old angle would
    // make “head left, then head right” end facing forward instead of right.
    const replacedJoints = new Set(lines.flatMap(line => {
      const match = /^(?:joint|wiggle) (\S+) ([xyz]) -?\d+(?:\.\d+)?$/.exec(line);
      return match ? [`${match[1]}.rotation.${match[2]}`] : [];
    }));
    const held = before.filter(value => !replacedJoints.has(key(value)));
    const sourceTemplate = index === 0 ? current : previousTemplate;
    const base = step.mode === "continue" ? structuredClone(sourceTemplate) : holdPose(held, activePrevious.bpm, baseSeconds);
    let template = applyAtomic(base, step.commands);
    if (lines.some(line => /^(action|dance) /.test(line))) {
      const heading = before.find(value => value.target === "root" && value.channel === "rotation" && value.axis === "y")?.value ?? 0;
      template = withFacing(template, heading);
    }
    const explicit = step.seconds;
    const ordinaryPose = !lines.some(line => /^(action|dance|skill) /.test(line)) && step.mode === "perform";
    const defaultSeconds = lines.some(line => /^dance /.test(line)) || step.mode === "continue" && template.dance ? 4 : ordinaryPose ? 2 : undefined;
    const transitionSeconds = Math.min(.45, .28 * 108 / template.bpm);
    const seconds = explicit ?? defaultSeconds ?? compileMotion(template).duration;
    const actionLines = lines.filter(line => /^action /.test(line));
    const cyclicGait = actionLines.length === 1 && /^action (walk|run|walk_wave|run_wave) 1$/.test(actionLines[0]);
    if (explicit !== undefined && actionLines.length && !cyclicGait && Math.abs(explicit - compileMotion(template).duration) > 1e-7)
      throw new Error("Counted body actions keep their complete repetitions. Omit a conflicting duration for that step.");
    if (seconds > 48) throw new Error("Keep the complete ordered sequence within 48 seconds.");
    // Tempo changes preserve the current musical phase. Other continuing edits
    // use the same native clock, so a support change never restarts arm rhythm.
    const offset = step.mode === "continue" && index > 0 ? playhead * sourceTemplate.bpm / template.bpm : 0;
    let performed = windowProgram(template, offset, seconds, transitionSeconds);
    const id = `ordered.phase.${index}`;
    const recovery = lines.some(line => /^(action|dance) /.test(line)) ? createPostureRecovery(activePrevious) : undefined;
    const blend = transition(recovery ?? activePrevious, template, offset, `${id}.transition`, transitionSeconds);
    const motionPhase = group(recovery ? `${id}.motion` : id, step.instruction, [performed.root, group(`${id}.settling`, "Settle → continue the phrase", [blend, wait(`${id}.settled`, seconds - transitionSeconds)], "sequence")]);
    const phase = recovery ? group(id, step.instruction, [recovery.root, motionPhase], "sequence") : motionPhase;
    const phaseProps = new Map([...activePrevious.props ?? [], ...template.props ?? []].map(prop => [prop.id, prop]));
    performed = { ...performed, root: phase, props: [...phaseProps.values()] };
    phaseRoots.push(phase);
    metadata.push({ id: `ordered.body.${index}.${id}`, label: template.title, instruction: step.instruction });
    for (const prop of [...activePrevious.props ?? [], ...template.props ?? []]) {
      const old = props.get(prop.id);
      if (old && JSON.stringify(old) !== JSON.stringify(prop)) throw new Error(`The sequence uses incompatible definitions for prop ${prop.id}.`);
      props.set(prop.id, prop);
    }
    previous = performed;
    previousTemplate = template;
    playhead = offset + seconds;
  }
  const lane = (name: Lane) => phaseRoots.map((root, index) => laneTree(root, name, `ordered.${name}.${index}`));
  const title = plan.steps.map(step => step.instruction).join(" → ");
  const program: OrderedProgram = { version: 2, bpm: current.bpm, title, ...(props.size ? { props: [...props.values()] } : {}),
    orderedSequence: { cues: metadata }, root: group("ordered_sequence", title, [
      group("ordered.body", "Body phases in order", lane("body"), "sequence"),
      group("arms", "Arms · all ordered phases", [group("ordered.arms", "Arm phases in order", lane("arms"), "sequence")]),
      group("details", "Joint details · all ordered phases", [group("ordered.details", "Detail phases in order", lane("details"), "sequence")]),
    ]) };
  if (compileMotion(program).duration > 48 + 1e-8) throw new Error("Keep the complete ordered sequence within 48 seconds.");
  return { program, cues: getOrderedSequenceCues(program) };
}

/** Recover cue timing from the live tree so tempo and reverse edits stay accurate. */
export function getOrderedSequenceCues(program: MotionProgram): OrderedCue[] {
  const metadata = (program as OrderedProgram).orderedSequence?.cues;
  // Motion JSON can contain unrelated extra metadata. Treat malformed cue data
  // as absent instead of allowing it to break an otherwise valid imported tree.
  if (!Array.isArray(metadata) || metadata.length < 2 || metadata.length > 4 || metadata.some(cue =>
    !cue || typeof cue !== "object" || typeof cue.id !== "string" || typeof cue.label !== "string" ||
    typeof cue.instruction !== "string" || !cue.instruction.trim() || cue.instruction.length > 400) ||
    new Set(metadata.map(cue => cue.id)).size !== metadata.length) return [];
  const timeline = compileMotion(program);
  return metadata.flatMap(cue => {
    const node = findNode(program.root, cue.id);
    const tracks = [...timeline.tracks, ...timeline.contacts ?? []].filter(track => track.ancestors.includes(cue.id) || track.id === cue.id);
    if (!node || !tracks.length) return [];
    return [{ ...cue, start: Math.min(...tracks.map(track => track.start)), duration: duration(node) }];
  }).sort((a, b) => a.start - b.start);
}
