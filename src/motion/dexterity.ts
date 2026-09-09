import { createDance } from "./skills";
import type {
  Axis,
  Curve,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
} from "./types";

export type DexteritySkill =
  | "finger_ripple"
  | "finger_touches"
  | "arm_wave"
  | "coin_roll";
type Side = "left" | "right";
type Finger = "thumb" | "index" | "middle" | "ring" | "pinky";

const parallel = (
  id: string,
  label: string,
  children: MotionNode[],
): GroupNode => ({ id, label, kind: "parallel", children });
const constant = (value: number): Curve => ({ kind: "constant", value });
function rotation(
  id: string,
  label: string,
  target: string,
  axis: Axis,
  curve: Curve,
  duration: number,
): CurveNode {
  return {
    id,
    label,
    kind: "curve",
    target,
    axis,
    channel: "rotation",
    curve,
    duration,
  };
}

// Compact smooth pulses overlap their neighbours but come completely to rest
// at either edge. Smoothstep interpolation gives zero velocity at each key,
// including the seam between the performed gesture and its breathing pause.
function pulse(peak: number, amplitude: number, width: number): Curve {
  return {
    kind: "keys",
    interpolation: "smooth",
    points: [
      [0, 0],
      [peak - width, 0],
      [peak, amplitude],
      [peak + width, 0],
      [1, 0],
    ],
  };
}

function loop(
  id: string,
  label: string,
  children: MotionNode[],
  cycle: number,
  repetitions: number,
): GroupNode {
  return {
    id,
    label,
    kind: "repeat",
    count: repetitions,
    children: [
      {
        id: `${id}.sequence`,
        label: "Gesture → settle",
        kind: "sequence",
        children: [
          parallel(`${id}.gesture`, "Coordinated joint pulses", children),
          rotation(
            `${id}.settle`,
            "Settle · open and still",
            "neck",
            "x",
            constant(0),
            cycle * 0.08,
          ),
        ],
      },
    ],
  };
}

function study(
  title: string,
  bpm: number,
  duration: number,
  arms: GroupNode,
  details: GroupNode,
): MotionProgram {
  const base = createDance("idle", "still", bpm);
  const resize = (node: MotionNode): MotionNode =>
    node.kind === "curve" || node.kind === "contact"
      ? { ...node, duration }
      : { ...node, children: node.children.map(resize) };
  if (base.root.kind !== "parallel")
    throw new Error("The standing study needs a parallel motion root.");
  return {
    ...base,
    title,
    root: {
      ...base.root,
      label: title,
      children: base.root.children.map((node) =>
        node.id === "arms"
          ? arms
          : node.id === "details"
            ? details
            : resize(node),
      ),
    },
  };
}

export function createFingerRipple(
  side: Side = "left",
  reverse = false,
  bpm = 108,
): MotionProgram {
  const cycle = (4 * 60) / bpm,
    duration = cycle * 2,
    active = cycle * 0.92;
  const sign = side === "left" ? 1 : -1;
  const order: Finger[] = ["pinky", "ring", "middle", "index", "thumb"];
  if (reverse) order.reverse();
  const title = `${side === "left" ? "Left" : "Right"} hand · ${reverse ? "thumb to pinky" : "pinky to thumb"} ripple`;

  // The neutral rig's arms hang down. Flexing the elbow and pitching the wrist
  // holds an open palm in front of the chest, clear of the face; wrist yaw
  // presents its width to the camera. Right-hand abduction/yaw and curls mirror.
  const arms = parallel("arms", "Arms · present an upright palm", [
    rotation(
      "arms.showcase.shoulder.x",
      "Shoulder · forward",
      `${side}_shoulder`,
      "x",
      constant(-25),
      duration,
    ),
    rotation(
      "arms.showcase.shoulder.z",
      "Shoulder · clear the torso",
      `${side}_shoulder`,
      "z",
      constant(sign * 35),
      duration,
    ),
    rotation(
      "arms.showcase.elbow",
      "Elbow · raise the forearm",
      `${side}_elbow`,
      "x",
      constant(-70),
      duration,
    ),
    rotation(
      "arms.showcase.wrist.x",
      "Wrist · upright fingers",
      `${side}_wrist`,
      "x",
      constant(-50),
      duration,
    ),
    rotation(
      "arms.showcase.wrist.y",
      "Palm · face the viewer",
      `${side}_wrist`,
      "y",
      constant(sign * -65),
      duration,
    ),
  ]);

  const fingers = order.map((finger, index) => {
    const peak = 0.15 + index * 0.155;
    const amplitudes = finger === "thumb" ? [32, 38, 26] : [58, 65, 42];
    return parallel(
      `ripple.${side}.${finger}`,
      `${finger} · curl then release`,
      amplitudes.map((angle, segment) =>
        rotation(
          `ripple.${side}.${finger}.${segment + 1}`,
          `Segment ${segment + 1} · delayed curl`,
          `${side}_${finger}_${segment + 1}`,
          "z",
          pulse(peak + segment * 0.018, sign * angle, 0.125),
          active,
        ),
      ),
    );
  });
  return study(
    title,
    bpm,
    duration,
    arms,
    parallel("details", "Joint details · finger ripple", [
      loop("ripple", "Repeat the traveling finger wave", fingers, cycle, 2),
    ]),
  );
}

export function createArmWave(reverse = false, bpm = 108): MotionProgram {
  const cycle = (8 * 60) / bpm,
    duration = cycle * 2,
    active = cycle * 0.92;
  const at = (phase: number) => (reverse ? 1 - phase : phase);
  const title = `Traveling wave · ${reverse ? "right to left" : "left to right"} fingertips`;
  const pose: MotionNode[] = [],
    moving: MotionNode[] = [],
    fingers: MotionNode[] = [];

  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    const first = side === "left";
    pose.push(
      rotation(
        `arms.open.${side}`,
        `${side} arm · outstretched`,
        `${side}_shoulder`,
        "z",
        constant(sign * 80),
        duration,
      ),
    );
    moving.push(
      parallel(`armwave.${side}`, `${side} arm · traveling rise and fall`, [
        rotation(
          `armwave.${side}.wrist`,
          "Wrist · lead the wave",
          `${side}_wrist`,
          "z",
          pulse(at(first ? 0.2 : 0.8), sign * 44, 0.11),
          active,
        ),
        rotation(
          `armwave.${side}.elbow`,
          "Elbow · follow the wrist",
          `${side}_elbow`,
          "z",
          pulse(at(first ? 0.31 : 0.69), sign * 30, 0.12),
          active,
        ),
        rotation(
          `armwave.${side}.shoulder`,
          "Shoulder · pass the wave",
          `${side}_shoulder`,
          "z",
          pulse(at(first ? 0.41 : 0.59), sign * 10, 0.12),
          active,
        ),
        rotation(
          `armwave.${side}.clavicle`,
          "Clavicle · shoulder lift",
          `${side}_clavicle`,
          "z",
          pulse(at(first ? 0.43 : 0.57), sign * 7, 0.115),
          active,
        ),
      ]),
    );
    fingers.push(
      parallel(
        `armwave.fingers.${side}`,
        `${side} fingertips · ${first !== reverse ? "start" : "finish"} the wave`,
        (["thumb", "index", "middle", "ring", "pinky"] as const).map(
          (finger, index) =>
            parallel(
              `armwave.fingers.${side}.${finger}`,
              `${finger} · articulated wave`,
              [1, 2, 3].map((segment) => {
                // At the source, the tip curls before the knuckle. At the destination,
                // the wave travels outward from the knuckle to the tip. Reversing time
                // reverses that propagation as well as the direction across the body.
                const phase = first
                  ? 0.115 - segment * 0.012
                  : 0.855 + segment * 0.012;
                const angle = (
                  finger === "thumb" ? [24, 28, 20] : [48, 55, 35]
                )[segment - 1];
                return rotation(
                  `armwave.fingers.${side}.${finger}.${segment}`,
                  `Segment ${segment} · passing pulse`,
                  `${side}_${finger}_${segment}`,
                  "z",
                  pulse(at(phase + (index - 2) * 0.003), sign * angle, 0.065),
                  active,
                );
              }),
            ),
        ),
      ),
    );
  }
  moving.push(
    parallel("armwave.center", "Chest · transfer across the body", [
      rotation(
        "armwave.chest",
        "Chest · gentle side transfer",
        "chest",
        "z",
        pulse(at(0.5), reverse ? -5 : 5, 0.13),
        active,
      ),
      rotation(
        "armwave.head",
        "Head · counterbalance",
        "head",
        "z",
        pulse(at(0.5), reverse ? 3 : -3, 0.13),
        active,
      ),
    ]),
  );
  const arms = parallel("arms", "Arms · fingertips to fingertips", [
    ...pose,
    loop("armwave", "Repeat the traveling arm wave", moving, cycle, 2),
  ]);
  const details = parallel("details", "Joint details · both hands", [
    loop("armwave.fingers", "Fingers · receive and release", fingers, cycle, 2),
  ]);
  return study(title, bpm, duration, arms, details);
}
