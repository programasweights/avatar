import { compileMotion, findNode } from "./engine";
import type {
  Axis,
  Curve,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
} from "./types";

export type DanceStyle = "salsa" | "cha_cha" | "robot" | "idle";
export type ArmStyle = "natural" | "robot" | "wave" | "still";
export const STYLE_LABELS: Record<DanceStyle, string> = {
  salsa: "Salsa · on 1",
  cha_cha: "Cha-cha · 2, 3, 4 & 1",
  robot: "Robot · hit and hold",
  idle: "Standing study",
};
const keys = (points: [number, number][], beats = 8): Curve => ({
  kind: "keys",
  points: points.map(([t, v]) => [t / beats, v]),
});
const sine = (
  amplitude: number,
  cycles: number,
  phase = 0,
  offset = 0,
): Curve => ({ kind: "sine", amplitude, cycles, phase, offset });
const constant = (value: number): Curve => ({ kind: "constant", value });
const group = (
  id: string,
  label: string,
  children: MotionNode[],
): GroupNode => ({ id, label, kind: "parallel", children });
function leaf(
  id: string,
  label: string,
  target: string,
  axis: Axis,
  curve: Curve,
  duration: number,
  channel: CurveNode["channel"] = "rotation",
): CurveNode {
  return { id, kind: "curve", label, target, axis, curve, duration, channel };
}

// A step is a foot target trajectory in metres, solved through the leg chain.
// The foot is stationary between transfers. Motion is authored, not sampled
// from an opaque full-body clip, so editing an arm cannot replace the gait.
function foot(
  id: string,
  side: string,
  duration: number,
  steps: [number, number, number][],
): GroupNode {
  const x: [number, number][] = [[0, 0]],
    y: [number, number][] = [[0, 0]],
    z: [number, number][] = [[0, 0]];
  let lastX = 0,
    lastZ = 0;
  for (const [beat, nextX, nextZ] of steps) {
    const start = beat - 0.7;
    x.push([start, lastX], [beat, nextX]);
    z.push([start, lastZ], [beat, nextZ]);
    y.push([start, 0], [beat - 0.35, 0.045], [beat, 0]);
    lastX = nextX;
    lastZ = nextZ;
  }
  for (const curve of [x, y, z])
    if (curve[curve.length - 1][0] < 8)
      curve.push([8, curve[curve.length - 1][1]]);
  return group(
    id,
    `${side === "left" ? "Left" : "Right"} foot · contact & transfer`,
    [
      leaf(
        `${id}.x`,
        "Side step · metres",
        `${side}_foot_ik`,
        "x",
        keys(x),
        duration,
        "position",
      ),
      leaf(
        `${id}.y`,
        "Lift · metres",
        `${side}_foot_ik`,
        "y",
        keys(y),
        duration,
        "position",
      ),
      leaf(
        `${id}.z`,
        "Forward step · metres",
        `${side}_foot_ik`,
        "z",
        keys(z),
        duration,
        "position",
      ),
    ],
  );
}
export function armBranch(
  style: ArmStyle,
  duration: number,
  prefix = "arms",
): GroupNode {
  const arms: MotionNode[] = [];
  for (const side of ["left", "right"]) {
    const sign = side === "left" ? 1 : -1;
    const phase = side === "left" ? 0 : 0.5;
    const id = `${prefix}.${side}`;
    const robot = style === "robot";
    const wave = style === "wave" && side === "right";
    const still = style === "still";
    const tracks = [
      leaf(
        `${id}.shoulder.x`,
        "Shoulder · forward reach",
        `${side}_shoulder`,
        "x",
        still
          ? constant(0)
          : robot
            ? keys([
                [0, -20],
                [1.7, -20],
                [2, -80],
                [3.7, -80],
                [4, -20],
                [5.7, -20],
                [6, -80],
                [7.7, -80],
                [8, -20],
              ])
            : sine(8, 2, phase, wave ? -60 : -10),
        duration,
      ),
      leaf(
        `${id}.shoulder.z`,
        "Shoulder · open",
        `${side}_shoulder`,
        "z",
        constant(still ? 0 : sign * (wave ? 70 : robot ? 35 : 12)),
        duration,
      ),
      leaf(
        `${id}.elbow`,
        "Elbow · flexion",
        `${side}_elbow`,
        "x",
        still
          ? constant(0)
          : robot
            ? keys([
                [0, -75],
                [1.7, -75],
                [2, -15],
                [3.7, -15],
                [4, -75],
                [5.7, -75],
                [6, -15],
                [7.7, -15],
                [8, -75],
              ])
            : sine(12, 2, phase + 0.25, wave ? -55 : -65),
        duration,
      ),
      leaf(
        `${id}.wrist`,
        "Wrist · articulation",
        `${side}_wrist`,
        wave ? "z" : "x",
        still
          ? constant(0)
          : robot
            ? keys([
                [0, -35],
                [1.8, -35],
                [2, 35],
                [3.8, 35],
                [4, -35],
                [5.8, -35],
                [6, 35],
                [7.8, 35],
                [8, -35],
              ])
            : sine(wave ? 25 : 8, wave ? 6 : 2, phase),
        duration,
      ),
    ];
    arms.push(group(id, `${side === "left" ? "Left" : "Right"} arm`, tracks));
  }
  return group(prefix, `Arms · ${style}`, arms);
}
export function createDance(
  style: DanceStyle,
  armStyle: ArmStyle = style === "robot" ? "robot" : "natural",
  bpm = 108,
): MotionProgram {
  const duration = (8 * 60) / bpm;
  let feet: GroupNode;
  if (style === "salsa")
    feet = group("feet", "Footwork · forward / back basic", [
      foot("feet.left", "left", duration, [
        [1, 0, 0.2],
        [3, 0, 0],
        [5, 0, 0],
        [7, 0, 0],
      ]),
      foot("feet.right", "right", duration, [
        [2, 0, 0],
        [5, 0, -0.2],
        [7, 0, 0],
      ]),
    ]);
  else if (style === "cha_cha")
    feet = group("feet", "Footwork · rock step + triple step", [
      foot("feet.left", "left", duration, [
        [2, 0, 0.16],
        [4, 0.11, 0],
        [5, 0.2, 0],
        [7, 0.2, 0],
        [8, 0, 0],
      ]),
      // Half-beat transfers have a shorter swing interval to avoid overlapping keys.
      group("feet.right", "Right foot · syncopated chasse", [
        leaf(
          "feet.right.x",
          "Side step · metres",
          "right_foot_ik",
          "x",
          keys([
            [0, 0],
            [3.7, 0],
            [4.5, 0.13],
            [5.4, 0.13],
            [6, 0.2],
            [7.3, 0.2],
            [8, 0],
          ]),
          duration,
          "position",
        ),
        leaf(
          "feet.right.y",
          "Lift · metres",
          "right_foot_ik",
          "y",
          keys([
            [0, 0],
            [2.3, 0],
            [2.65, 0.025],
            [3, 0],
            [4.1, 0],
            [4.3, 0.03],
            [4.5, 0],
            [5.3, 0],
            [5.65, 0.04],
            [6, 0],
            [7.3, 0],
            [7.65, 0.04],
            [8, 0],
          ]),
          duration,
          "position",
        ),
        leaf(
          "feet.right.z",
          "Back rock · metres",
          "right_foot_ik",
          "z",
          keys([
            [0, 0],
            [5.3, 0],
            [6, -0.16],
            [7.3, -0.16],
            [8, 0],
          ]),
          duration,
          "position",
        ),
      ]),
    ]);
  else
    feet = group(
      "feet",
      "Feet · planted",
      ["left", "right"].flatMap((side) =>
        ["x", "y", "z"].map((axis) =>
          leaf(
            `feet.${side}.${axis}`,
            `${side} foot ${axis}`,
            `${side}_foot_ik`,
            axis as Axis,
            constant(0),
            duration,
            "position",
          ),
        ),
      ),
    );
  const moving = style !== "idle";
  const robot = style === "robot";
  const torso = group("torso", "Body · weight, hips & counter-rotation", [
    leaf(
      "torso.shift",
      "Weight transfer · metres",
      "root",
      "x",
      style === "cha_cha"
        ? keys([
            [0, 0],
            [2, 0.045],
            [3, -0.04],
            [4, 0.1],
            [4.5, 0.04],
            [5, 0.17],
            [6, 0.11],
            [7, 0.22],
            [8, 0],
          ])
        : sine(moving ? 0.045 : 0, 2, -0.125),
      duration,
      "position",
    ),
    leaf(
      "torso.bounce",
      "Knee softness · metres",
      "root",
      "y",
      sine(moving ? 0.01 : 0, robot ? 2 : 8, 0.25, -0.035),
      duration,
      "position",
    ),
    leaf(
      "torso.travel",
      "Forward weight · metres",
      "root",
      "z",
      style === "salsa"
        ? keys([
            [0, 0],
            [1, 0.065],
            [2, 0],
            [3, 0.015],
            [4, 0],
            [5, -0.065],
            [6, 0],
            [7, -0.015],
            [8, 0],
          ])
        : constant(0),
      duration,
      "position",
    ),
    leaf(
      "torso.hips.y",
      "Hip rotation · degrees",
      "hips",
      "y",
      sine(moving ? 9 : 0, 2, 0.125),
      duration,
    ),
    leaf(
      "torso.hips.z",
      "Hip settling · degrees",
      "hips",
      "z",
      sine(moving ? 4 : 0, 2, -0.125),
      duration,
    ),
    leaf(
      "torso.spine",
      "Spine counter-rotation",
      "spine",
      "y",
      sine(moving ? -6 : 0, 2, 0.125),
      duration,
    ),
    leaf(
      "torso.chest",
      "Chest counter-rotation",
      "chest",
      "y",
      sine(moving ? -3 : 0, 2, 0.125),
      duration,
    ),
    leaf(
      "torso.head",
      "Head · keep gaze forward",
      "head",
      "y",
      sine(moving ? 2 : 0, 2, 0.125),
      duration,
    ),
  ]);
  return {
    version: 2,
    title: STYLE_LABELS[style],
    bpm,
    root: group("motion", STYLE_LABELS[style], [
      feet,
      torso,
      armBranch(style === "idle" ? "still" : armStyle, duration),
      group("details", "Joint details", [
        leaf(
          "details.neutral",
          "Neutral offset",
          "neck",
          "x",
          constant(0),
          duration,
        ),
      ]),
    ]),
  };
}
export function replaceArms(
  program: MotionProgram,
  style: ArmStyle,
): MotionProgram {
  const arms = findNode(program.root, "arms");
  const duration = arms
    ? compileMotion({ ...program, root: arms }).duration
    : 0;
  if (!arms)
    throw new Error(
      "This imported program has no arms branch. Edit its curves in the motion JSON.",
    );
  const replace = (node: MotionNode): MotionNode =>
    node.id === "arms"
      ? armBranch(style, duration)
      : node.kind === "curve" || node.kind === "contact"
        ? node
        : { ...node, children: node.children.map(replace) };
  return { ...program, root: replace(program.root) };
}
export function changeTempo(
  program: MotionProgram,
  bpm: number,
): MotionProgram {
  const scale = program.bpm / bpm;
  const visit = (node: MotionNode): MotionNode =>
    node.kind === "curve" || node.kind === "contact"
      ? { ...node, duration: node.duration * scale }
      : { ...node, children: node.children.map(visit) };
  return { ...program, bpm, root: visit(program.root) };
}
export function jointOffset(
  program: MotionProgram,
  target: string,
  axis: Axis,
  angle: number,
  oscillate = false,
): MotionProgram {
  const id = `detail.${target}.${axis}`;
  const details = findNode(program.root, "details");
  const duration = compileMotion(
    details ? { ...program, root: details } : program,
  ).duration;
  const node = leaf(
    id,
    `${target.replaceAll("_", " ")} · ${axis}`,
    target,
    axis,
    oscillate ? sine(angle / 2, 4, -0.25, angle / 2) : constant(angle),
    duration,
  );
  if (!details) {
    let rootId = "motion_with_details";
    while (findNode(program.root, rootId)) rootId += "_";
    return {
      ...program,
      root: group(rootId, program.title, [
        program.root,
        group("details", "Joint details", [node]),
      ]),
    };
  }
  const visit = (n: MotionNode): MotionNode =>
    n.id === "details" && n.kind === "parallel"
      ? { ...n, children: [...n.children.filter((c) => c.id !== id), node] }
      : n.kind === "curve" || n.kind === "contact"
        ? n
        : { ...n, children: n.children.map(visit) };
  return { ...program, root: visit(program.root) };
}
