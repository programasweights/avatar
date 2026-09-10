import { findNode, sampleCurve } from "./engine";
import type {
  Axis,
  Curve,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
} from "./types";

export type GangnamSupport = "both" | "left" | "right";
export const GANGNAM_BPM = 132;
const BEATS = 16;
type Keys = [number, number][];
const constant = (value: number): Curve => ({ kind: "constant", value });
const keys = (points: Keys): Curve => ({
  kind: "keys",
  // These points already sample authored easing. Easing every sample again
  // stops the joint at each key, producing a visible mechanical stutter.
  interpolation: "linear",
  points: points.map(([beat, value]) => [beat / BEATS, value]),
});
const group = (
  id: string,
  label: string,
  children: MotionNode[],
): GroupNode => ({ id, label, kind: "parallel", children });
const smooth = (x: number) => x * x * (3 - 2 * x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// A compact, editable eight-beat step pattern: R, L, R, R / L, R, L, L.
// Every foot leaves and returns to the same contact, so the stage-space target
// cannot skate during the planted portion of the bounce.
const RIDING_STEPS = [
  "right",
  "left",
  "right",
  "right",
  "left",
  "right",
  "left",
  "left",
] as const;
const beatShape = (points: Keys, phase: number) =>
  sampleCurve(
    {
      kind: "keys",
      points,
      interpolation: "smooth",
    },
    phase,
  );
const liftShape: Keys = [
  [0, 0],
  [0.1, 0],
  [0.28, 0.72],
  [0.48, 1],
  [0.68, 0.72],
  [0.88, 0],
  [1, 0],
];
const hopShape: Keys = [
  [0, 0],
  [0.2, 0],
  [0.36, 0.8],
  [0.5, 1],
  [0.66, 0.55],
  [0.77, 0],
  [1, 0],
];
const bodyShape: Keys = [
  [0, -0.145],
  [0.12, -0.17],
  [0.35, -0.075],
  [0.5, -0.045],
  [0.66, -0.075],
  [0.88, -0.13],
  [1, -0.145],
];

/** A complete 16-beat horse-riding / lasso phrase made from joint curves. */
export function createGangnam({
  bpm = GANGNAM_BPM,
  support = "both",
}: { bpm?: number; support?: GangnamSupport } = {}): MotionProgram {
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240)
    throw new Error("Choose a tempo from 30 to 240 BPM.");
  if (!["both", "left", "right"].includes(support))
    throw new Error("Choose both, left, or right support.");
  const duration = (BEATS * 60) / bpm;
  const leaf = (
    id: string,
    label: string,
    target: string,
    axis: Axis,
    curve: Curve,
    channel: CurveNode["channel"] = "rotation",
  ): CurveNode => ({
    id,
    label,
    kind: "curve",
    target,
    axis,
    curve,
    channel,
    duration,
  });
  // Author beats rather than frame samples: these key times mark anticipation,
  // takeoff, flight and contact. The player interpolates at any frame rate.
  const beatCurve = (fn: (beat: number, phase: number) => number): Curve => {
    const times = [
      0, 0.1, 0.12, 0.2, 0.28, 0.35, 0.36, 0.48, 0.5, 0.66, 0.68, 0.77, 0.88,
    ];
    const points: Keys = [];
    for (let beat = 0; beat < BEATS; beat++)
      for (const phase of times) points.push([beat + phase, fn(beat, phase)]);
    points.push([BEATS, fn(0, 0)]);
    return keys(points);
  };
  const single = support !== "both";
  const feet = group(
    "feet",
    single
      ? `Footwork · hop on the ${support} foot`
      : "Footwork · right, left, right-right / left, right, left-left",
    (["left", "right"] as const).map((side) => {
      const sign = side === "left" ? 1 : -1;
      const free = single && side !== support;
      const active = (beat: number) => RIDING_STEPS[beat % 8] === side;
      return group(
        `feet.${side}`,
        free
          ? `${side} leg · hold the tuck`
          : `${side} foot · lift, land, rebound`,
        [
          leaf(
            `feet.${side}.x`,
            "Side step · airborne only",
            `${side}_foot_ik`,
            "x",
            free
              ? constant(sign * 0.02)
              : beatCurve(
                  (beat, phase) =>
                    sign *
                    (0.06 +
                      (!single && active(beat)
                        ? 0.075 * beatShape(liftShape, phase)
                        : 0)),
                ),
            "position",
          ),
          leaf(
            `feet.${side}.y`,
            free
              ? "Free foot · hold 38 cm above the floor"
              : "Foot contact and lift",
            `${side}_foot_ik`,
            "y",
            beatCurve((beat, phase) =>
              free
                ? 0.38 + 0.035 * beatShape(hopShape, phase)
                : single || !active(beat)
                  ? 0.035 * beatShape(hopShape, phase)
                  : 0.235 * beatShape(liftShape, phase),
            ),
            "position",
          ),
          leaf(
            `feet.${side}.z`,
            free ? "Tucked heel · behind the knee" : "Toe flick · forward",
            `${side}_foot_ik`,
            "z",
            free
              ? constant(-0.17)
              : beatCurve((beat, phase) =>
                  !single && active(beat)
                    ? 0.12 * beatShape(liftShape, phase)
                    : 0,
                ),
            "position",
          ),
          leaf(
            `feet.${side}.knee_plane.x`,
            "Knee plane · open the riding stance",
            `${side}_knee_pole`,
            "x",
            single
              ? constant(sign * (free ? 1 : 0.2))
              : beatCurve(
                  (beat, phase) =>
                    sign *
                    (0.3 +
                      (active(beat) ? 0.7 * beatShape(liftShape, phase) : 0)),
                ),
            "position",
          ),
          leaf(
            `feet.${side}.knee_plane.z`,
            "Knee plane · forward component",
            `${side}_knee_pole`,
            "z",
            single
              ? constant(free ? 0.4 : 1)
              : beatCurve(
                  (beat, phase) =>
                    1 - (active(beat) ? 0.6 * beatShape(liftShape, phase) : 0),
                ),
            "position",
          ),
          leaf(
            `feet.${side}.toe_turn`,
            "Foot · turn out with the lifted knee",
            `${side}_ankle`,
            "y",
            single
              ? constant(free ? sign * 20 : 0)
              : beatCurve((beat, phase) =>
                  active(beat) ? sign * 20 * beatShape(liftShape, phase) : 0,
                ),
          ),
        ],
      );
    }),
  );
  const balance = group(
    "balance",
    single
      ? `Balance · over the ${support} foot`
      : "Balance · riding bounce and weight transfer",
    [
      leaf(
        "balance.height",
        "Compress → spring → land",
        "root",
        "y",
        beatCurve((beat, phase) => {
          const emphasis = beat % 4 === 3 ? 1.1 : beat % 2 === 1 ? 0.94 : 1;
          return -0.145 + (beatShape(bodyShape, phase) + 0.145) * emphasis;
        }),
        "position",
      ),
      leaf(
        "balance.shift",
        "Weight above the supporting foot",
        "root",
        "x",
        beatCurve((beat, phase) =>
          single
            ? (support === "left" ? 1 : -1) * 0.15
            : (RIDING_STEPS[beat % 8] === "left" ? -1 : 1) *
              0.105 *
              Math.sin(Math.PI * phase) ** 2,
        ),
        "position",
      ),
      leaf(
        "balance.depth",
        "Sit back into the bounce",
        "root",
        "z",
        constant(-0.025),
        "position",
      ),
      leaf(
        "balance.hips",
        "Hip balance · counter the lifted leg",
        "hips",
        "z",
        beatCurve((beat, phase) =>
          single
            ? (support === "left" ? -1 : 1) * 4
            : (RIDING_STEPS[beat % 8] === "left" ? 1 : -1) *
              3 *
              Math.sin(Math.PI * phase) ** 2,
        ),
      ),
    ],
  );
  const torso = group("torso", "Body · grounded rhythm", [
    balance,
    group("torso.groove", "Torso and gaze · keep the rhythm", [
      leaf("torso.lean", "Forward riding lean", "hips", "x", constant(7)),
      leaf("torso.chest", "Chest · follow the rebound", "chest", "x", {
        kind: "sine", amplitude: 2.5, cycles: 16, phase: -0.08, offset: -5,
      }),
      leaf("torso.twist", "Shoulders · small counter-rotation", "chest", "y", {
        kind: "sine",
        amplitude: 5,
        cycles: 8,
      }),
      leaf(
        "torso.head",
        "Chin · nod on the beat",
        "head",
        "x",
        { kind: "sine", amplitude: 4, cycles: 16, phase: -0.12, offset: 2 },
      ),
      leaf("torso.head_tilt", "Head · loose side-to-side groove", "head", "z", {
        kind: "sine", amplitude: 2.5, cycles: 8, phase: -0.1,
      }),
      leaf("torso.gaze", "Gaze · keep playing to the audience", "head", "y", {
        kind: "sine", amplitude: 4, cycles: 2,
      }),
    ]),
  ]);

  // Euler values are fitted against the actual neutral rig. Reins place the
  // crossed fists in front of the chest; the second eight lifts the right fist
  // above the head and circles it while the left hand keeps the reins.
  const reins = {
    left: {
      shoulder: [-56, -14.7, -14],
      elbow: [-28.5, -0.7, -31.6],
      wrist: [81.7, -44, 88],
    },
    right: {
      shoulder: [-54.5, -0.9, 8.6],
      elbow: [-35, 7.8, 53],
      wrist: [88.7, 35.3, -86.7],
    },
  };
  const lasso = {
    left: {
      shoulder: [-34.2, -24.4, 2.5],
      elbow: [-54.6, 7.8, -48.1],
      wrist: [81.7, -44, 88],
    },
    right: {
      shoulder: [-132.5, 3.4, -41.5],
      elbow: [-67.8, -9.1, 48.9],
      wrist: [-8, 0, 0],
    },
  };
  const armCurve = (
    fn: (beat: number, lassoAmount: number) => number,
  ): Curve => {
    const points: Keys = [];
    for (let tick = 0; tick <= BEATS * 8; tick++) {
      const beat = tick / 8;
      const amount =
        beat < 7.5
          ? 0
          : beat < 8.25
            ? smooth((beat - 7.5) / 0.75)
            : beat < 14.75
              ? 1
              : smooth(Math.max(0, (15.75 - beat) / 1));
      points.push([beat, fn(beat, amount)]);
    }
    return keys(points);
  };
  const arms = group(
    "arms",
    "Arms · crossed reins → overhead lasso",
    (["left", "right"] as const).map((side) =>
      group(
        `arms.${side}`,
        side === "right"
          ? "Right arm · reins and lasso"
          : "Left arm · hold the reins",
        (["shoulder", "elbow", "wrist"] as const).flatMap((joint) =>
          (["x", "y", "z"] as const).map((axis, i) =>
            leaf(
              `arms.${side}.${joint}.${axis}`,
              `${joint} · ${axis === "x" ? "lift and pump" : axis === "y" ? "turn" : "cross and circle"}`,
              `${side}_${joint}`,
              axis,
              armCurve((beat, amount) => {
                let value = mix(
                  reins[side][joint][i],
                  lasso[side][joint][i],
                  amount,
                );
                // Both hands pump together; a shallow oval of the raised shoulder
                // and forearm gives the lasso a clear orbit rather than a static fist.
                const pump = Math.sin(2 * Math.PI * beat);
                if (joint === "shoulder" && axis === "x")
                  value += (1 - amount) * 8 * pump;
                if (joint === "elbow" && axis === "x")
                  value -= (1 - amount) * 6 * Math.sin(2 * Math.PI * (beat - 0.125));
                if (side === "right") {
                  if (joint === "shoulder" && axis === "x")
                    value += amount * 13 * Math.cos(Math.PI * beat);
                  if (joint === "shoulder" && axis === "z")
                    value += amount * 15 * Math.sin(Math.PI * beat);
                  if (joint === "elbow" && axis === "x")
                    value += amount * 8 * Math.sin(Math.PI * beat);
                  if (joint === "wrist" && axis === "y")
                    value += amount * 12 * Math.sin(Math.PI * beat);
                }
                return value;
              }),
            ),
          ),
        ),
      ),
    ),
  );
  const details = group(
    "details",
    "Hands · curled reins and lasso grip",
    (["left", "right"] as const).flatMap((side) => {
      const sign = side === "left" ? 1 : -1;
      return (["thumb", "index", "middle", "ring", "pinky"] as const).map(
        (finger) => {
          const segments = [1, 2, 3].map((segment) =>
            leaf(
              `grip.${side}.${finger}.${segment}`,
              `Knuckle ${segment} · curl`,
              `${side}_${finger}_${segment}`,
              "z",
              constant(
                sign *
                  (finger === "thumb"
                    ? [-48.7, 27.7, 30.7][segment - 1]
                    : [60, 85, 70][segment - 1]),
              ),
            ),
          );
          // A thumb needs opposition as well as flexion: curling a spread thumb
          // alone leaves a conspicuous thumbs-up instead of closing the fist.
          if (finger === "thumb")
            segments.push(
              leaf(
                `grip.${side}.thumb.opposition`,
                "Thumb · turn across the palm",
                `${side}_thumb_1`,
                "x",
                constant(45),
              ),
              leaf(
                `grip.${side}.thumb.sweep`,
                "Thumb pad · fold across the fingers",
                `${side}_thumb_1`,
                "y",
                constant(sign * 25.7),
              ),
            );
          return group(
            `grip.${side}.${finger}`,
            `${side} ${finger} · curled grip`,
            segments,
          );
        },
      );
    }),
  );
  const title = single
    ? `Gangnam Style · on the ${support} foot`
    : "Gangnam Style · horse-riding and lasso";
  return {
    version: 2,
    title,
    bpm,
    dance: { style: "gangnam", support },
    root: group("motion", title, [feet, torso, arms, details]),
  };
}

/** Change the support constraint without replacing an edited upper body. */
export function changeGangnamSupport(
  program: MotionProgram,
  support: GangnamSupport | "other",
): MotionProgram {
  if (program.dance?.style !== "gangnam")
    throw new Error(
      "Choose a Gangnam Style dance before changing its support foot.",
    );
  const nextSupport =
    support === "other"
      ? program.dance.support === "left"
        ? "right"
        : "left"
      : support;
  const replacement = createGangnam({ bpm: program.bpm, support: nextSupport });
  const replace = (node: MotionNode): MotionNode => {
    if (node.id === "feet" || node.id === "balance")
      return findNode(replacement.root, node.id)!;
    return node.kind === "curve" || node.kind === "contact"
      ? node
      : { ...node, children: node.children.map(replace) };
  };
  if (!findNode(program.root, "feet") || !findNode(program.root, "balance"))
    throw new Error(
      "This dance has no editable footwork and balance branches.",
    );
  return {
    ...program,
    title: replacement.title,
    dance: replacement.dance,
    root: { ...replace(program.root), label: replacement.title },
  };
}
