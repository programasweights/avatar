import { compileMotion, findNode, sampleTimeline, updateNode } from "./engine";
import { JOINTS } from "./rigDefinition";
import type {
  Axis,
  Curve,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
} from "./types";

type Side = "left" | "right";
export type Finger = "thumb" | "index" | "middle" | "ring" | "pinky";
export interface FrozenRotation {
  id: string;
  wrapperId: string;
  wrapped: boolean;
  targets: string[];
  time: number;
}

export function fingerTargets(side: Side, finger: Finger): string[] {
  const targets = [1, 2, 3].map((segment) => `${side}_${finger}_${segment}`);
  if (targets.some((target) => !Object.hasOwn(JOINTS, target)))
    throw new Error("Unknown finger.");
  return targets;
}

/** Arm edits include the wrist, but leave each finger's own articulation free. */
export function armTargets(side?: Side): string[] {
  const sides: Side[] = side ? [side] : ["left", "right"];
  return sides.flatMap((arm) =>
    ["clavicle", "shoulder", "elbow", "wrist"].map((joint) => `${arm}_${joint}`),
  );
}

/** A leaf selects one joint; a finger branch selects all its articulated segments. */
export function branchTargets(node: MotionNode): string[] {
  if (node.kind === "contact") return [];
  if (node.kind === "curve") {
    return node.channel === "rotation" && Object.hasOwn(JOINTS, node.target)
      ? [node.target]
      : [];
  }
  return [...new Set(node.children.flatMap(branchTargets))];
}

/** Pause means local rotation. Ancestors and the rest of the timeline keep moving. */
export function editingBlockReason(
  program: MotionProgram,
  targets: string[],
): string | null {
  if (!targets.length) return "Select an articulated joint or finger branch.";
  if (targets.some((target) => !Object.hasOwn(JOINTS, target)))
    return "Only articulated joint rotations can be edited here.";
  const timeline = compileMotion(program);
  for (const side of ["left", "right"]) {
    if (
      timeline.tracks.some((track) => track.target === `${side}_foot_ik`) &&
      targets.some(
        (target) =>
          target === "hips" ||
          new RegExp(`^${side}_(hip|knee|ankle)$`).test(target),
      )
    ) {
      return "Foot IK also moves this joint. Edit the foot trajectory instead of pausing its rotation.";
    }
  }
  for (const contact of timeline.contacts ?? []) {
    const anchors =
      contact.mode === "fingertips"
        ? [contact.effector, contact.target]
        : [contact.from, contact.to];
    const fingers = anchors.map((anchor) =>
      anchor.replace(/_(tip|[123])$/, ""),
    );
    const side = anchors[0].split("_")[0];
    const shared = [
      "hips",
      "spine",
      "spine_mid",
      "chest",
      `${side}_clavicle`,
      `${side}_shoulder`,
      `${side}_elbow`,
      `${side}_wrist`,
    ];
    if (
      targets.some(
        (target) =>
          shared.includes(target) ||
          fingers.some((finger) => target.startsWith(finger + "_")),
      )
    ) {
      return "Contact choreography uses this selection. Try Finger ripple to edit independent finger curves.";
    }
  }
  return null;
}

function mapTree(
  node: MotionNode,
  visit: (node: MotionNode) => MotionNode | undefined,
): MotionNode | undefined {
  if (node.kind === "curve" || node.kind === "contact") return visit(node);
  const children = node.children
    .map((child) => mapTree(child, visit))
    .filter((child): child is MotionNode => !!child);
  return visit({ ...node, children });
}

/** Add a final replacement overlay; retain every original curve for exact restoration. */
export function freezeTargets(
  program: MotionProgram,
  targets: string[],
  time: number,
): { program: MotionProgram; token: FrozenRotation } {
  const selected = [...new Set(targets)];
  const reason = editingBlockReason(program, selected);
  if (reason) throw new Error(reason);
  if (!Number.isFinite(time)) throw new Error("The pause time must be finite.");
  const timeline = compileMotion(program);
  const sampledTime = Math.max(0, Math.min(time, timeline.duration));
  const pose = sampleTimeline(timeline, sampledTime);
  const ids: string[] = [];
  mapTree(program.root, (node) => {
    ids.push(node.id);
    return node;
  });
  let serial = 1;
  while (
    ids.some(
      (id) =>
        id === `editing.freeze.${serial}` ||
        id.startsWith(`editing.freeze.${serial}.`),
    )
  )
    serial++;
  const id = `editing.freeze.${serial}`;
  const wrapped =
    program.root.kind !== "parallel" ||
    /^editing\.freeze\.\d+\.root$/.test(program.root.id);
  const wrapperId = wrapped ? `${id}.root` : program.root.id;
  const curves: MotionNode[] = selected.flatMap((target) =>
    (["x", "y", "z"] as Axis[]).map((axis) => {
      const value =
        pose.find(
          (value) =>
            value.target === target &&
            value.channel === "rotation" &&
            value.axis === axis,
        )?.value ?? 0;
      // A valid timeline can exceed the per-curve limit of 120 seconds.
      const children: CurveNode[] = [];
      for (let start = 0; start < timeline.duration; start += 120) {
        children.push({
          id: `${id}.${target}.${axis}.${children.length}`,
          kind: "curve",
          label: `${target} · paused ${axis}`,
          target,
          axis,
          channel: "rotation",
          duration: Math.min(120, timeline.duration - start),
          blend: "replace",
          curve: { kind: "constant", value },
        });
      }
      return children.length === 1
        ? children[0]
        : {
            id: `${id}.${target}.${axis}`,
            kind: "sequence",
            label: `${target} · hold ${axis}`,
            children,
          };
    }),
  );
  const overlay: GroupNode = {
    id,
    kind: "parallel",
    label: "Paused rotations",
    children: curves,
  };
  const root: GroupNode =
    !wrapped && program.root.kind === "parallel"
      ? { ...program.root, children: [...program.root.children, overlay] }
      : {
          id: wrapperId,
          kind: "parallel",
          label: program.root.label,
          children: [program.root, overlay],
        };
  const next: MotionProgram = { ...program, root };
  compileMotion(next);
  return {
    program: next,
    token: { id, wrapperId, wrapped, targets: selected, time: sampledTime },
  };
}

/** Remove just this pause. Other pauses and subsequent edits remain in place. */
export function restoreFrozen(
  program: MotionProgram,
  token: FrozenRotation,
): MotionProgram {
  const wrapper = findNode(program.root, token.wrapperId);
  if (
    !wrapper ||
    wrapper.kind !== "parallel" ||
    !wrapper.children.some((child) => child.id === token.id)
  ) {
    throw new Error(
      "This pause is no longer in the current motion. Use Undo to recover the earlier program.",
    );
  }
  const root = mapTree(program.root, (node) => {
    if (node.id === token.id) return undefined;
    if (
      token.wrapped &&
      node.id === token.wrapperId &&
      node.kind === "parallel" &&
      node.children.length === 1
    )
      return node.children[0];
    return node;
  });
  if (!root) throw new Error("The original motion is missing.");
  const next = { ...program, root };
  compileMotion(next);
  return next;
}

function curveMagnitude(curve: Curve): number {
  if (curve.kind === "constant") return Math.abs(curve.value);
  if (curve.kind === "sine")
    return Math.abs(curve.offset ?? 0) + Math.abs(curve.amplitude);
  return Math.max(...curve.points.map(([, value]) => Math.abs(value)));
}

export function rotationMagnitude(
  node: CurveNode,
): { label: string; value: number; max: number } | null {
  if (node.channel !== "rotation" || !Object.hasOwn(JOINTS, node.target))
    return null;
  const value = curveMagnitude(node.curve);
  const curl =
    node.axis === "z" &&
    /_(thumb|index|middle|ring|pinky)_[123]$/.test(node.target);
  return {
    label: curl ? "Curl (°)" : "Rotation (°)",
    value,
    max: Math.max(180, value),
  };
}

/** Scale angles, preserving key times, interpolation, phase, cycles, and mirrored signs.
 * Retain a reference node across a slider gesture so a zeroed curve can recover its shape.
 */
export function withRotationMagnitude(
  program: MotionProgram,
  nodeId: string,
  degrees: number,
  reference?: CurveNode,
): MotionProgram {
  const node = findNode(program.root, nodeId);
  if (!node || node.kind !== "curve" || !rotationMagnitude(node))
    throw new Error("Select an independent rotation curve.");
  const reason = editingBlockReason(program, [node.target]);
  if (reason) throw new Error(reason);
  if (
    reference &&
    (reference.id !== node.id ||
      reference.target !== node.target ||
      reference.axis !== node.axis ||
      reference.channel !== node.channel)
  ) {
    throw new Error(
      "The slider reference must describe the selected rotation curve.",
    );
  }
  const source = reference ?? node;
  const magnitude = rotationMagnitude(source)!;
  if (!Number.isFinite(degrees) || degrees < 0 || degrees > magnitude.max)
    throw new Error(`Choose an angle from 0 to ${magnitude.max} degrees.`);
  const curve = source.curve;
  let scaled: Curve;
  if (curve.kind === "constant") {
    const sign =
      Math.sign(curve.value) ||
      (node.target.startsWith("right_") &&
      node.axis === "z" &&
      /_(thumb|index|middle|ring|pinky)_/.test(node.target)
        ? -1
        : 1);
    scaled = { ...curve, value: sign * degrees };
  } else {
    if (magnitude.value === 0 && degrees !== 0)
      throw new Error(
        "Keep the original slider reference to restore a zeroed curve's shape, or use Undo.",
      );
    const scale = magnitude.value === 0 ? 0 : degrees / magnitude.value;
    scaled =
      curve.kind === "keys"
        ? {
            ...curve,
            points: curve.points.map(([time, value]) => [time, value * scale]),
          }
        : {
            ...curve,
            amplitude: curve.amplitude * scale,
            ...(curve.offset === undefined
              ? {}
              : { offset: curve.offset * scale }),
          };
  }
  const next = {
    ...program,
    root: updateNode(
      program.root,
      node.id,
      (original) => ({ ...original, curve: scaled }) as CurveNode,
    ),
  };
  compileMotion(next);
  return next;
}

/** Resolve only validated model tokens; never infer intent from the user's text. */
export function resolveEditTarget(
  target: string,
  side: Side,
  selectedTargets: string[],
): string[] {
  if (!["left", "right"].includes(side))
    throw new Error("Choose the active left or right hand.");
  if (target === "selected") {
    if (!selectedTargets.length)
      throw new Error("Select a joint or finger branch first.");
    if (selectedTargets.some((joint) => !Object.hasOwn(JOINTS, joint)))
      throw new Error("The selection must contain articulated joints.");
    return [...new Set(selectedTargets)];
  }
  if (["hips", "spine", "spine_mid", "chest", "neck", "head"].includes(target))
    return [target];
  const arm = /^(?:(left|right|both)_)?(arm|arms)$/.exec(target);
  if (arm) {
    if (arm[1] === "both" || (!arm[1] && arm[2] === "arms"))
      return armTargets();
    return armTargets((arm[1] as Side) || side);
  }
  const match =
    /^(?:(left|right|both)_)?(clavicle|shoulder|elbow|wrist|hip|knee|ankle|toes|(?:thumb|index|middle|ring|pinky)(?:_[123])?)$/.exec(
      target,
    );
  if (!match) throw new Error(`Unknown motion edit target: ${target}`);
  const sides: Side[] =
    match[1] === "both" ? ["left", "right"] : [(match[1] as Side) || side];
  const finger = ["thumb", "index", "middle", "ring", "pinky"].includes(
    match[2],
  );
  return sides.flatMap((hand) =>
    finger ? fingerTargets(hand, match[2] as Finger) : [`${hand}_${match[2]}`],
  );
}
