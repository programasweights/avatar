import { createFingerRipple, createArmWave } from "./dexterity";
import type { DexteritySkill } from "./dexterity";
import { createDance } from "./skills";
import type {
  Axis,
  ContactNode,
  Curve,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
} from "./types";
const group = (
  id: string,
  label: string,
  children: MotionNode[],
): GroupNode => ({ id, label, kind: "parallel", children });
const scalar = (
  id: string,
  target: string,
  axis: Axis,
  value: number | Curve,
  duration: number,
): CurveNode => ({
  id,
  label: id.split(".").slice(1).join(" · "),
  kind: "curve",
  target,
  axis,
  channel: "rotation",
  duration,
  curve: typeof value === "number" ? { kind: "constant", value } : value,
});
function resize(node: MotionNode, duration: number): MotionNode {
  return node.kind === "curve" || node.kind === "contact"
    ? { ...node, duration }
    : { ...node, children: node.children.map((n) => resize(n, duration)) };
}
function baseStudy(
  title: string,
  side: "left" | "right",
  bpm: number,
  duration: number,
): MotionProgram {
  const idle = createDance("idle", "still", bpm),
    present = createFingerRipple(side, false, bpm);
  if (idle.root.kind !== "parallel" || present.root.kind !== "parallel")
    throw new Error("Expected parallel study");
  const arms = present.root.children.find((n) => n.id === "arms")!;
  return {
    ...idle,
    title,
    root: {
      ...idle.root,
      label: title,
      children: idle.root.children.map((n) =>
        resize(n.id === "arms" ? arms : n, duration),
      ),
    },
  };
}
function replace(program: MotionProgram, id: string, node: MotionNode) {
  if (program.root.kind === "parallel")
    program.root.children = program.root.children.map((n) =>
      n.id === id ? node : n,
    );
}
export function createFingertipTouches(
  side: "left" | "right" = "left",
  reverse = false,
  bpm = 108,
): MotionProgram {
  const beat = (2 * 60) / bpm,
    cycle = 4 * beat,
    duration = cycle * 2,
    sign = side === "left" ? 1 : -1;
  const fingers = ["index", "middle", "ring", "pinky"];
  if (reverse) fingers.reverse();
  const program = baseStudy(
    `${side} hand · thumb meets each fingertip`,
    side,
    bpm,
    duration,
  );
  const phases = fingers.map((finger, index) => {
    const id = `touch.${index}.${finger}`;
    const contact: ContactNode = {
      id: `${id}.contact`,
      label: `Thumb → ${finger} tip`,
      kind: "contact",
      mode: "fingertips",
      effector: `${side}_thumb_tip`,
      target: `${side}_${finger}_tip`,
      duration: beat,
      weight: {
        kind: "keys",
        points: [
          [0, 0],
          [0.25, 1],
          [0.7, 1],
          [1, 0],
        ],
      },
    };
    return group(id, `Touch ${finger} · release`, [
      ...[42, 62, 32].map((degrees, n) =>
        scalar(
          `${id}.segment${n + 1}`,
          `${side}_${finger}_${n + 1}`,
          "z",
          {
            kind: "keys",
            points: [
              [0, 0],
              [0.25, sign * degrees],
              [0.7, sign * degrees],
              [1, 0],
            ],
          },
          beat,
        ),
      ),
      contact,
    ]);
  });
  replace(
    program,
    "details",
    group("details", "Joint details · sequential fingertip contacts", [
      {
        id: "touches",
        label: "Index → middle → ring → pinky",
        kind: "repeat",
        count: 2,
        children: phases,
      },
    ]),
  );
  return program;
}
export function createCoinRoll(
  side: "left" | "right" = "left",
  reverse = false,
  bpm = 108,
): MotionProgram {
  const step = (1.5 * 60) / bpm,
    cycle = 6 * step,
    duration = cycle * 2,
    sign = side === "left" ? 1 : -1;
  const program = baseStudy(
    `${side} hand · coin across the knuckles`,
    side,
    bpm,
    duration,
  );
  program.props = [
    { id: "coin", kind: "coin", radius: 0.022, thickness: 0.003 },
  ];
  replace(
    program,
    "arms",
    group("arms", "Arms · present the back of the hand", [
      scalar("coinpose.shoulder.x", `${side}_shoulder`, "x", -25, duration),
      scalar(
        "coinpose.shoulder.z",
        `${side}_shoulder`,
        "z",
        sign * 30,
        duration,
      ),
      scalar("coinpose.elbow", `${side}_elbow`, "x", -80, duration),
      scalar("coinpose.wrist.x", `${side}_wrist`, "x", -5, duration),
      scalar("coinpose.wrist.y", `${side}_wrist`, "y", -sign * 45, duration),
      scalar("coinpose.wrist.z", `${side}_wrist`, "z", -sign * 5, duration),
    ]),
  );
  const fingers = ["index", "middle", "ring", "pinky"];
  if (reverse) fingers.reverse();
  const path = [...fingers, ...fingers.slice(0, -1).reverse()];
  const phases = path.slice(0, -1).map((finger, i) => {
    const next = path[i + 1],
      id = `coinpass.${i}`;
    const travel = reverse ? -1 : 1;
    const transfer: ContactNode = {
      id: `${id}.contact`,
      label: `Coin · ${finger} → ${next}`,
      kind: "contact",
      mode: "prop_transfer",
      prop: "coin",
      from: `${side}_${finger}_2`,
      to: `${side}_${next}_2`,
      duration: step,
      progress: {
        kind: "keys",
        points: [
          [0, 0],
          [0.12, 0],
          [0.88, 1],
          [1, 1],
        ],
      },
      rolls: (i < 3 ? 1 : -1) * travel,
      rollOffset: (i < 3 ? i : 6 - i) * travel,
    };
    return group(id, `${finger} lifts · ${next} receives`, [
      scalar(
        `${id}.lift`,
        `${side}_${finger}_1`,
        "z",
        {
          kind: "keys",
          points: [
            [0, 0],
            [0.18, 0],
            [0.4, -sign * 18],
            [0.7, 0],
            [1, 0],
          ],
        },
        step,
      ),
      scalar(
        `${id}.receive`,
        `${side}_${next}_1`,
        "z",
        {
          kind: "keys",
          points: [
            [0, 0],
            [0.35, 0],
            [0.65, sign * 16],
            [0.9, 0],
            [1, 0],
          ],
        },
        step,
      ),
      transfer,
    ]);
  });
  const pose: MotionNode[] = [];
  for (const f of ["index", "middle", "ring", "pinky"])
    [5, 68, 38].forEach((degrees, n) =>
      pose.push(
        scalar(
          `coinpose.${f}.${n}`,
          `${side}_${f}_${n + 1}`,
          "z",
          sign * degrees,
          duration,
        ),
      ),
    );
  pose.push(
    scalar("coinpose.thumb", `${side}_thumb_1`, "z", sign * 28, duration),
  );
  replace(
    program,
    "details",
    group("details", "Finger poses · coin handoffs", [
      ...pose,
      {
        id: "coinroll",
        label: "Roll across · roll back",
        kind: "repeat",
        count: 2,
        children: phases,
      },
    ]),
  );
  return program;
}
export function createDexterity(
  skill: DexteritySkill,
  side: "left" | "right" = "left",
  reverse = false,
  bpm = 108,
): MotionProgram {
  if (skill === "finger_ripple") return createFingerRipple(side, reverse, bpm);
  if (skill === "finger_touches")
    return createFingertipTouches(side, reverse, bpm);
  if (skill === "arm_wave")
    return createArmWave((side === "right") !== reverse, bpm);
  if (skill === "coin_roll") return createCoinRoll(side, reverse, bpm);
  throw new Error("Unknown dexterity skill");
}
