import { compileMotion, findNode } from "./engine";
import { armBranch, changeTempo } from "./skills";
import type { Curve, CurveNode, MotionNode, MotionProgram } from "./types";
import { waveOverlay, WAVE_OVERLAY_ID } from "./waveOverlay";

type Side = "left" | "right";
const HAND =
  /^(left|right)_(clavicle|shoulder|elbow|wrist|hand_camera|(thumb|index|middle|ring|pinky)_[123])$/;
const FINGER = /^(left|right)_(thumb|index|middle|ring|pinky)_[123]$/;
const WAVE = WAVE_OVERLAY_ID;
const sideOf = (target: string) => target.split("_")[0] as Side;
const isDetail = (id: string) =>
  /(^|\.)detail\./.test(id) || id.startsWith("editing.freeze.");
const opposite = (side: Side): Side => (side === "left" ? "right" : "left");

function isMoving(curve: Curve): boolean {
  if (curve.kind === "constant") return Math.abs(curve.value) > 1e-10;
  if (curve.kind === "sine")
    return Math.abs(curve.amplitude) + Math.abs(curve.offset ?? 0) > 1e-10;
  return curve.points.some(([, value]) => Math.abs(value) > 1e-10);
}

/** Infer the performed hand from the current tree, never the inspector selection. */
export function currentMotionHand(program: MotionProgram): Side | undefined {
  const timeline = compileMotion(program);
  const sides = new Set<Side>();
  for (const contact of timeline.contacts ?? [])
    sides.add(
      sideOf(contact.mode === "fingertips" ? contact.effector : contact.from),
    );
  for (const track of timeline.tracks) {
    if (
      (track.ancestors.includes(WAVE) && HAND.test(track.target)) ||
      /^(left|right)_hand_camera$/.test(track.target) ||
      (FINGER.test(track.target) &&
        !isDetail(track.id) &&
        isMoving(track.curve))
    )
      sides.add(sideOf(track.target));
  }
  // A standalone finger direction also establishes a hand. Details do not
  // override an established choreography when a visitor inspects another joint.
  if (!sides.size)
    for (const track of timeline.tracks)
      if (FINGER.test(track.target) && isMoving(track.curve))
        sides.add(sideOf(track.target));
  return sides.size === 1 ? [...sides][0] : undefined;
}

function scaleCurve(curve: Curve, sign: number): Curve {
  if (sign === 1) return curve;
  if (curve.kind === "constant") return { ...curve, value: sign * curve.value };
  if (curve.kind === "sine")
    return {
      ...curve,
      amplitude: sign * curve.amplitude,
      ...(curve.offset === undefined ? {} : { offset: sign * curve.offset }),
    };
  return {
    ...curve,
    points: curve.points.map(([t, value]) => [t, sign * value]),
  };
}

/** Switch one performed hand, retaining node IDs, authored keys and other joints. */
export function changeMotionHand(
  program: MotionProgram,
  requested: Side | "other",
): MotionProgram {
  const timeline = compileMotion(program);
  const source = currentMotionHand(program);
  if (!source)
    throw new Error(
      "Choose a one-hand motion first, such as a finger ripple, coin roll, or wave. This motion does not have one unambiguous hand to switch.",
    );
  const destination = requested === "other" ? opposite(source) : requested;
  if (source === destination) return program;
  const hasWave = !!findNode(program.root, WAVE);
  const onlyDetails =
    !timeline.contacts?.length &&
    !timeline.tracks.some(
      (track) =>
        track.target.endsWith("_hand_camera") ||
        (FINGER.test(track.target) &&
          !isDetail(track.id) &&
          isMoving(track.curve)),
    );
  const baselineArm = (id: string) =>
    (hasWave || onlyDetails) && /(^|\.)arms\.(left|right)(\.|$)/.test(id);
  const competing = timeline.tracks.some(
    (track) =>
      HAND.test(track.target) &&
      sideOf(track.target) === destination &&
      !baselineArm(track.id) &&
      isMoving(track.curve),
  );
  if (competing)
    throw new Error(
      `The ${destination} arm or hand already has its own movement. Remove that edit or load a one-hand example before switching hands.`,
    );
  const rename = (value: string) =>
    value.replace(new RegExp(`^${source}_`), `${destination}_`);
  const label = (value: string) =>
    value.replace(new RegExp(`\\b${source}\\b`, "gi"), (word) =>
      word[0] === word[0].toUpperCase()
        ? destination[0].toUpperCase() + destination.slice(1)
        : destination,
    );
  const visit = (node: MotionNode): MotionNode => {
    if (node.kind === "curve") {
      if (
        !HAND.test(node.target) ||
        sideOf(node.target) !== source ||
        baselineArm(node.id)
      )
        return node;
      // Hand cameras encode a view angle, not an anatomical rotation.
      const sign = node.target.endsWith("_hand_camera")
        ? 1
        : node.channel === "position"
          ? node.axis === "x"
            ? -1
            : 1
          : node.axis === "x"
            ? 1
            : -1;
      return {
        ...node,
        target: rename(node.target),
        label: label(node.label),
        curve: scaleCurve(node.curve, sign),
      };
    }
    if (node.kind === "contact") {
      return node.mode === "fingertips"
        ? {
            ...node,
            label: label(node.label),
            effector: rename(node.effector),
            target: rename(node.target),
          }
        : {
            ...node,
            label: label(node.label),
            from: rename(node.from),
            to: rename(node.to),
          };
    }
    const children = node.children.map(visit);
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, label: label(node.label), children };
  };
  const next = {
    ...program,
    title: label(program.title),
    root: visit(program.root),
  };
  compileMotion(next);
  return next;
}

function reverseCurve(curve: Curve): Curve {
  if (curve.kind === "constant") return curve;
  if (curve.kind === "sine")
    return {
      ...curve,
      cycles: -curve.cycles,
      phase: (curve.phase ?? 0) + curve.cycles,
    };
  if (curve.interpolation === "hold")
    throw new Error(
      "This imported motion uses held keyframes. Change them to Smooth or Linear before reversing playback.",
    );
  return {
    ...curve,
    points: [...curve.points].reverse().map(([t, value]) => [1 - t, value]),
  };
}

/** Reverse the actual playback tree, including its camera and contact lifetimes. */
export function reverseCurrentMotion(program: MotionProgram): MotionProgram {
  compileMotion(program);
  const visit = (node: MotionNode): { node: MotionNode; duration: number } => {
    if (node.kind === "curve")
      return {
        node: { ...node, curve: reverseCurve(node.curve) },
        duration: node.duration,
      };
    if (node.kind === "contact")
      return {
        node:
          node.mode === "fingertips"
            ? { ...node, weight: reverseCurve(node.weight) }
            : {
                ...node,
                progress: reverseCurve(node.progress),
                ...(node.visibility
                  ? { visibility: reverseCurve(node.visibility) }
                  : {}),
              },
        duration: node.duration,
      };
    const children = node.children.map(visit);
    if (node.kind === "parallel") {
      const duration = Math.max(...children.map((child) => child.duration));
      if (children.some((child) => Math.abs(child.duration - duration) > 1e-8))
        throw new Error(
          "This imported motion has parallel branches of different lengths. Align their durations before reversing playback.",
        );
      return {
        node: { ...node, children: children.map((child) => child.node) },
        duration,
      };
    }
    return {
      node: {
        ...node,
        children: children.map((child) => child.node).reverse(),
      },
      duration:
        children.reduce((total, child) => total + child.duration, 0) *
        (node.kind === "repeat" ? node.count! : 1),
    };
  };
  const next = { ...program, root: visit(program.root).node };
  compileMotion(next);
  return next;
}

export function scaleTempo(
  program: MotionProgram,
  factor: number,
): MotionProgram {
  if (!Number.isFinite(factor) || factor < 0.25 || factor > 4)
    throw new Error("Choose a speed multiplier between 0.25 and 4.");
  const bpm = program.bpm * factor;
  if (bpm < 30 || bpm > 240)
    throw new Error(
      `That would set ${Number(bpm.toFixed(3))} BPM. Choose a speed between 30 and 240 BPM.`,
    );
  return changeTempo(program, bpm);
}

/** A side-specific hello wave is an overlay; it does not replace the gait or other arm. */
export function waveHand(program: MotionProgram, side: Side): MotionProgram {
  const duration = compileMotion(program).duration;
  if (duration > 120)
    throw new Error(
      "A wave supports motions up to two minutes. Shorten this motion before adding it.",
    );
  const existing = findNode(program.root, WAVE);
  if (existing && !waveOverlay(program))
    throw new Error(
      "The imported motion already uses the hello_wave ID outside a top-level wave overlay. Rename that node before adding a wave.",
    );
  const source = armBranch("wave", duration, WAVE, side).children.find(
    (node) => node.id === `${WAVE}.${side}`,
  )!;
  if (source.kind !== "parallel") throw new Error("Expected an arm branch.");
  const curves = source.children.map(
    (node) => ({ ...node, blend: "replace" }) as CurveNode,
  );
  for (const joint of ["shoulder", "elbow", "wrist"])
    for (const axis of ["x", "y", "z"] as const)
      if (
        !curves.some(
          (node) => node.target === `${side}_${joint}` && node.axis === axis,
        )
      )
        curves.push({
          id: `${WAVE}.${side}.${joint}.${axis}`,
          kind: "curve",
          label: `${joint} · ${axis}`,
          target: `${side}_${joint}`,
          axis,
          channel: "rotation",
          duration,
          blend: "replace",
          curve: { kind: "constant", value: 0 },
        });
  const wave: MotionNode = {
    id: WAVE,
    kind: "parallel",
    label: `${side === "left" ? "Left" : "Right"} hand · wave hello`,
    children: curves,
  };
  let root: MotionNode;
  if (program.root.kind === "parallel") {
    const children = program.root.children.filter((node) => node !== existing);
    const isDetail = (node: MotionNode) =>
      node.id === "details" || node.id.startsWith("editing.freeze.");
    const firstDetail = children.findIndex(isDetail);
    if (
      firstDetail >= 0 &&
      children.slice(firstDetail).some((node) => !isDetail(node))
    )
      throw new Error(
        "This composition places other motion after its joint details. Reorder those branches before adding a wave.",
      );
    // Explicit joint offsets and pauses remain the final editing layers.
    children.splice(firstDetail < 0 ? children.length : firstDetail, 0, wave);
    root = { ...program.root, children };
  } else {
    let id = "motion_with_wave";
    while (findNode(program.root, id)) id += "_";
    root = {
      id,
      kind: "parallel",
      label: program.root.label,
      children: [program.root, wave],
    };
  }
  const next = { ...program, root };
  compileMotion(next);
  return next;
}
