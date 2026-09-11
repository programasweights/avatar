import { compileMotion, findNode, sampleTimeline } from "./engine";
import { changeGangnamSupport, type GangnamSupport } from "./gangnam";
import type { Axis, CurveNode, GroupNode, MotionNode, MotionProgram } from "./types";

const OVERLAY = "support_constraint";
const WRAPPER = "motion_with_support";
type Support = GangnamSupport;

function currentOverlay(program: MotionProgram, strict = true): GroupNode | undefined {
  const node = findNode(program.root, OVERLAY);
  if (!node) return undefined;
  const inParallel = (parent: MotionNode): boolean => parent === node ||
    parent.kind === "parallel" && parent.children.some(inParallel);
  if (!inParallel(program.root) || node.kind !== "parallel" ||
      node.children.length !== 1 ||
      !["left", "right", "both"].some(side => node.children[0].id === `${OVERLAY}.${side}`)) {
    if (strict) throw new Error("The imported motion already uses the support_constraint ID. Rename that branch before changing support.");
    return undefined;
  }
  return node;
}

function removeOverlay(node: MotionNode, overlay: MotionNode): MotionNode | undefined {
  if (node === overlay) return undefined;
  if (node.kind === "curve" || node.kind === "contact") return node;
  const children = node.children.map(child => removeOverlay(child, overlay)).filter((child): child is MotionNode => !!child);
  if (!children.length) return undefined;
  if (node.id === WRAPPER && children.length === 1) return children[0];
  return { ...node, children };
}

/** A subsequent explicit joint edit takes ownership of its one rotation axis. */
export function releaseSupportRotation(program: MotionProgram, target: string, axis: Axis): MotionProgram {
  if (!/^(root|hips|(left|right)_(hip|knee|ankle|toes))$/.test(target)) return program;
  const overlay = currentOverlay(program, false);
  if (!overlay) return program;
  const owns = (node: MotionNode): boolean => node.kind === "curve"
    ? node.target === target && node.channel === "rotation" && node.axis === axis
    : node.kind !== "contact" && node.children.some(owns);
  if (!owns(overlay)) return program;
  const visit = (node: MotionNode): MotionNode | undefined => {
    if (node.kind === "curve") return node.target === target && node.channel === "rotation" && node.axis === axis ? undefined : node;
    if (node.kind === "contact") return node;
    const children = node.children.map(visit).filter((child): child is MotionNode => !!child);
    return children.length ? { ...node, children } : undefined;
  };
  const changed = visit(overlay)!;
  const replace = (node: MotionNode): MotionNode => node === overlay ? changed :
    node.kind === "curve" || node.kind === "contact" ? node : { ...node, children: node.children.map(replace) };
  return { ...program, root: replace(program.root) };
}

/** Held poses in an ordered sequence retain foot positions, but not editor IDs. */
function heldSupport(program: MotionProgram): Support {
  const timeline = compileMotion(program);
  const pose = sampleTimeline(timeline, timeline.duration);
  const height = (side: "left" | "right") => pose.find(value =>
    value.target === `${side}_foot_ik` && value.channel === "position" && value.axis === "y")?.value ?? 0;
  if (height("left") > height("right") + 0.1) return "right";
  if (height("right") > height("left") + 0.1) return "left";
  return "both";
}

/** Support is a constraint on the current scene; Gangnam retains its authored hopping. */
export function changeSupport(program: MotionProgram, support: Support | "other"): MotionProgram {
  if (program.dance?.style === "gangnam") return changeGangnamSupport(program, support);
  if (!["left", "right", "both", "other"].includes(support))
    throw new Error("Choose both, left, right, or the opposite supporting foot.");
  const overlay = currentOverlay(program);
  const current = overlay ? overlay.children[0].id.slice(`${OVERLAY}.`.length) as Support : heldSupport(program);
  const selected = support === "other" ? current === "left" ? "right" : "left" : support;
  let root = program.root;
  if (overlay) root = removeOverlay(root, overlay)!;
  // Removing the overlay restores the original footwork, including all edits.
  if (selected === "both" && (overlay || current === "both")) return { ...program, root };
  const duration = compileMotion({ ...program, root }).duration;
  const id = `${OVERLAY}.${selected}`;
  const children: MotionNode[] = [];
  const hold = (target: string, channel: CurveNode["channel"], axis: Axis, value: number) => {
    const key = `${id}.${target}.${channel}.${axis}`;
    // Keep long imported sequences valid without changing their timeline.
    const pieces: CurveNode[] = [];
    for (let start = 0; start < duration; start += 120) pieces.push({
      id: `${key}.${pieces.length}`, kind: "curve", label: `${target.replaceAll("_", " ")} · ${axis}`,
      target, channel, axis, duration: Math.min(120, duration - start), blend: "replace",
      curve: { kind: "constant", value },
    });
    children.push(pieces.length === 1 ? pieces[0] : {
      id: key, kind: "sequence", label: `${target.replaceAll("_", " ")} · hold`, children: pieces,
    });
  };
  const single = selected !== "both";
  // The rig anchors IK feet to the stage. Shift the pelvis over the planted
  // ankle while leaving the original upper-body curves and contacts untouched.
  for (const axis of ["x", "y", "z"] as const) {
    hold("root", "position", axis, axis === "x" ? single ? selected === "left" ? 0.09 : -0.09 : 0 : axis === "y" ? -0.035 : 0);
    hold("hips", "position", axis, 0);
    hold("hips", "rotation", axis, 0);
  }
  // Keep the character's facing, but return floor-pose tilt to an upright base.
  for (const axis of ["x", "z"] as const) hold("root", "rotation", axis, 0);
  for (const side of ["left", "right"] as const) {
    const free = single && side !== selected;
    for (const axis of ["x", "y", "z"] as const) {
      hold(`${side}_foot_ik`, "position", axis, free ? axis === "y" ? 0.34 : axis === "z" ? 0.1 : 0 : 0);
      hold(`${side}_knee_pole`, "position", axis, axis === "z" ? 1 : 0);
      for (const joint of ["hip", "knee", "ankle", "toes"]) {
        hold(`${side}_${joint}`, "rotation", axis, 0);
        hold(`${side}_${joint}`, "position", axis, 0);
      }
    }
    // An earlier floor pose may explicitly use FK. The standing constraint
    // owns the complete leg so that inherited joint offsets cannot undo IK.
    hold(`${side}_foot_ik_enabled`, "position", "x", 1);
  }
  const stance: GroupNode = {
    id: OVERLAY, kind: "parallel", label: single ? `Balance on the ${selected} foot` : "Stand on both feet",
    children: [{ id, kind: "parallel", label: single ? `${selected} foot planted · opposite knee raised` : "Both feet planted", children }],
  };
  if (root.kind === "parallel") root = { ...root, children: [...root.children, stance] };
  else {
    if (findNode(root, WRAPPER)) throw new Error("Rename the imported motion_with_support branch before changing support.");
    root = { id: WRAPPER, kind: "parallel", label: root.label, children: [root, stance] };
  }
  const next = { ...program, root };
  compileMotion(next);
  return next;
}
