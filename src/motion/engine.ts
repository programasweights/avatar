import type {
  ContactTrack,
  ContactValue,
  Curve,
  MotionNode,
  MotionProgram,
  PoseValue,
  Timeline,
  Track,
} from "./types";

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
export function sampleCurve(curve: Curve, progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  if (curve.kind === "constant") return curve.value;
  if (curve.kind === "sine")
    return (
      (curve.offset ?? 0) +
      curve.amplitude *
        Math.sin(2 * Math.PI * (curve.cycles * p + (curve.phase ?? 0)))
    );
  const points = curve.points;
  if (p <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [b, y] = points[i];
    const [a, x] = points[i - 1];
    if (p <= b) {
      let t = (p - a) / (b - a);
      if (curve.interpolation === "hold") return p === b ? y : x;
      if (curve.interpolation !== "linear") t = t * t * (3 - 2 * t);
      return x + (y - x) * t;
    }
  }
  return points[points.length - 1][1];
}

// Strict validation also protects imported programs. Nothing is silently pruned.
export function compileMotion(program: MotionProgram): Timeline {
  if (
    program.version !== 2 ||
    typeof program.title !== "string" ||
    !finite(program.bpm) ||
    program.bpm < 30 ||
    program.bpm > 240
  )
    throw new Error(
      "Expected a v2 motion program with a tempo between 30 and 240 BPM.",
    );
  const tracks: Track[] = [];
  const contacts: ContactTrack[] = [];
  if (
    program.dance !== undefined &&
    (program.dance?.style !== "gangnam" ||
      !["both", "left", "right"].includes(program.dance.support))
  )
    throw new Error("Invalid dance configuration.");
  if (program.props !== undefined) {
    if (!Array.isArray(program.props) || program.props.length > 8)
      throw new Error("At most eight props are supported.");
    const propIds = new Set<string>();
    for (const prop of program.props) {
      if (
        !prop ||
        !/^[a-z][a-z0-9_]*$/.test(prop.id) ||
        propIds.has(prop.id) ||
        prop.kind !== "coin" ||
        !finite(prop.radius) ||
        prop.radius < 0.005 ||
        prop.radius > 0.1 ||
        !finite(prop.thickness) ||
        prop.thickness < 0.001 ||
        prop.thickness > 0.02
      )
        throw new Error("Invalid coin prop.");
      propIds.add(prop.id);
    }
  }
  const ids = new Set<string>();
  let nodes = 0;
  function validate(node: MotionNode, depth: number) {
    if (!node || depth > 16 || ++nodes > 2000)
      throw new Error("Program exceeds 16 tree levels or 2,000 nodes.");
    if (typeof node.id !== "string" || !node.id || ids.has(node.id))
      throw new Error("Every node needs a unique ID.");
    ids.add(node.id);
    if (typeof node.label !== "string")
      throw new Error("Every node needs a label.");
    if (node.kind === "contact") {
      if (!finite(node.duration) || node.duration <= 0 || node.duration > 120)
        throw new Error("Invalid contact duration.");
      if (node.mode === "fingertips") {
        if (
          ![node.effector, node.target].every((x) =>
            /^(left|right)_(thumb|index|middle|ring|pinky)_tip$/.test(x),
          ) ||
          node.effector === node.target ||
          node.effector.split("_")[0] !== node.target.split("_")[0]
        )
          throw new Error("Invalid fingertip contact.");
      } else if (node.mode === "prop_transfer") {
        if (
          !program.props?.some((prop) => prop.id === node.prop) ||
          ![node.from, node.to].every((x) =>
            /^(left|right)_(index|middle|ring|pinky)_[12]$/.test(x),
          ) ||
          node.from.split("_")[0] !== node.to.split("_")[0] ||
          !finite(node.rolls ?? 1) ||
          Math.abs(node.rolls ?? 1) > 8 ||
          !finite(node.rollOffset ?? 0) ||
          Math.abs(node.rollOffset ?? 0) > 64
        )
          throw new Error("Invalid prop transfer.");
      } else throw new Error("Unknown contact mode.");
      const curve = node.mode === "fingertips" ? node.weight : node.progress;
      // Reuse the exact scalar-curve validator without adding a synthetic tree node.
      validateCurve(curve);
      if (node.mode === "prop_transfer" && node.visibility !== undefined)
        validateCurve(node.visibility);
      return;
    }
    if (node.kind !== "curve") {
      if (
        !["sequence", "parallel", "repeat"].includes(node.kind) ||
        !Array.isArray(node.children) ||
        !node.children.length
      )
        throw new Error("A group needs a valid kind and children.");
      if (
        node.kind === "repeat" &&
        (!Number.isInteger(node.count) || node.count! < 1 || node.count! > 32)
      )
        throw new Error("Repeat count must be 1–32.");
      node.children.forEach((child) => validate(child, depth + 1));
      return;
    }
    if (
      !/^[a-z][a-z0-9_]*$/.test(node.target) ||
      !["x", "y", "z"].includes(node.axis) ||
      !["rotation", "position"].includes(node.channel)
    )
      throw new Error("Invalid joint channel.");
    if (node.blend !== undefined && !["add", "replace"].includes(node.blend))
      throw new Error("Invalid blending mode.");
    if (!finite(node.duration) || node.duration <= 0 || node.duration > 120)
      throw new Error(
        "Curve duration must be greater than zero and at most 120 seconds.",
      );
    validateCurve(node.curve);
  }
  function validateCurve(c: Curve) {
    if (!c || !["constant", "sine", "keys"].includes(c.kind))
      throw new Error("Unknown curve type.");
    if (c.kind === "constant" && !finite(c.value))
      throw new Error("Non-finite curve value.");
    if (
      c.kind === "sine" &&
      (![c.amplitude, c.cycles, c.phase ?? 0, c.offset ?? 0].every(finite) ||
        Math.abs(c.cycles) > 240)
    )
      throw new Error("Invalid oscillator.");
    if (c.kind === "keys") {
      if (
        !Array.isArray(c.points) ||
        c.points.length < 2 ||
        c.points.length > 256 ||
        (c.interpolation !== undefined &&
          !["smooth", "linear", "hold"].includes(c.interpolation))
      )
        throw new Error("Invalid keyframes.");
      let previous = -1;
      for (const point of c.points) {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every(finite) ||
          point[0] < 0 ||
          point[0] > 1 ||
          point[0] <= previous
        )
          throw new Error("Keyframe times must increase within 0–1.");
        previous = point[0];
      }
    }
  }
  validate(program.root, 0);
  function visit(node: MotionNode, start: number, ancestors: string[]): number {
    if (tracks.length + contacts.length > 10000)
      throw new Error("Expanded program exceeds 10,000 leaves.");
    if (node.kind === "contact") {
      contacts.push({ ...node, start, ancestors });
      return node.duration;
    }
    if (node.kind === "curve") {
      tracks.push({ ...node, start, ancestors });
      return node.duration;
    }
    const path = [...ancestors, node.id];
    if (node.kind === "parallel")
      return Math.max(
        ...node.children.map((child) => visit(child, start, path)),
      );
    let duration = 0;
    for (let i = 0; i < (node.kind === "repeat" ? node.count! : 1); i++) {
      for (const child of node.children)
        duration += visit(child, start + duration, path);
    }
    return duration;
  }
  const duration = visit(program.root, 0, []);
  if (tracks.length + contacts.length > 10000)
    throw new Error("Expanded program exceeds 10,000 leaves.");
  if (duration > 600) throw new Error("Program exceeds 10 minutes.");
  const ownedContacts = new Map<string, ContactTrack[]>();
  for (const contact of contacts) {
    const owner =
      contact.mode === "prop_transfer"
        ? `prop:${contact.prop}`
        : `tip:${contact.effector}`;
    const tracks = ownedContacts.get(owner) ?? [];
    tracks.push(contact);
    ownedContacts.set(owner, tracks);
  }
  for (const [owner, tracks] of ownedContacts) {
    tracks.sort((a, b) => a.start - b.start);
    let end = -Infinity;
    for (const track of tracks) {
      const epsilon = Number.EPSILON * 16 * Math.max(1, duration);
      if (track.start < end - epsilon)
        throw new Error(
          `Overlapping contacts for ${owner}. Sequence them or use different effectors/props.`,
        );
      end = Math.max(end, track.start + track.duration);
    }
  }

  return {
    tracks,
    duration,
    ...(contacts.length ? { contacts } : {}),
    ...(program.props?.length ? { props: program.props } : {}),
  };
}

// Repeated durations accumulate floating-point rounding. Treat boundaries within
// a handful of ulps as one instant, owned only by the incoming leaf.
function ownsTime(
  start: number,
  duration: number,
  time: number,
  finalTime: number,
): boolean {
  const end = start + duration;
  const epsilon =
    Number.EPSILON *
    16 *
    Math.max(1, Math.abs(time), Math.abs(end), Math.abs(finalTime));
  return (
    time >= start - epsilon &&
    (time < end - epsilon ||
      (Math.abs(end - finalTime) <= epsilon && time <= end + epsilon))
  );
}

export function sampleTimeline(timeline: Timeline, time: number): PoseValue[] {
  const result = new Map<string, PoseValue>();
  // A leaf owns its channel only during its interval. Adjacent sequence nodes
  // don't both apply at a shared boundary; the final frame remains scrubbable.
  const t = Math.max(0, Math.min(time, timeline.duration));
  for (const track of timeline.tracks) {
    if (!ownsTime(track.start, track.duration, t, timeline.duration)) continue;
    const key = `${track.target}.${track.channel}.${track.axis}`;
    const value = sampleCurve(track.curve, (t - track.start) / track.duration);
    result.set(key, {
      target: track.target,
      channel: track.channel,
      axis: track.axis,
      value:
        value + (track.blend === "replace" ? 0 : (result.get(key)?.value ?? 0)),
    });
  }
  return [...result.values()];
}
export function findNode(root: MotionNode, id: string): MotionNode | undefined {
  if (root.id === id) return root;
  if (root.kind !== "curve" && root.kind !== "contact")
    for (const child of root.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
}
export function updateNode(
  root: MotionNode,
  id: string,
  update: (node: MotionNode) => MotionNode,
): MotionNode {
  if (root.id === id) return update(root);
  return root.kind === "curve" || root.kind === "contact"
    ? root
    : {
        ...root,
        children: root.children.map((child) => updateNode(child, id, update)),
      };
}
export function activeNodes(timeline: Timeline, time: number): Set<string> {
  return new Set(
    [...timeline.tracks, ...(timeline.contacts ?? [])]
      .filter((t) => time >= t.start && time < t.start + t.duration)
      .flatMap((t) => [t.id, ...t.ancestors]),
  );
}
export function sampleContacts(
  timeline: Timeline,
  time: number,
): ContactValue[] {
  const t = Math.max(0, Math.min(time, timeline.duration));
  return (timeline.contacts ?? [])
    .filter((c) => ownsTime(c.start, c.duration, t, timeline.duration))
    .map((c) => {
      const p = (t - c.start) / c.duration;
      if (c.mode === "fingertips")
        return {
          mode: c.mode,
          effector: c.effector,
          target: c.target,
          weight: Math.max(0, Math.min(1, sampleCurve(c.weight, p))),
        };
      return {
        mode: c.mode,
        prop: c.prop,
        from: c.from,
        to: c.to,
        progress: Math.max(0, Math.min(1, sampleCurve(c.progress, p))),
        rolls: c.rolls ?? 1,
        rollOffset: c.rollOffset ?? 0,
        ...(c.visibility === undefined
          ? {}
          : {
              visibility: Math.max(
                0,
                Math.min(1, sampleCurve(c.visibility, p)),
              ),
            }),
      };
    });
}
