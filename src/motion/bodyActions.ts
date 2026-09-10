import { compileMotion, sampleCurve, sampleTimeline } from "./engine";
import { reverseCurrentMotion, waveHand } from "./relative";
import type {
  Axis,
  Curve,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
  PoseValue,
} from "./types";

export const BODY_ACTIONS = [
  "walk",
  "run",
  "walk_wave",
  "run_wave",
  "jump",
  "bow",
  "crouch",
  "kneel",
  "lie_down",
  "sit",
  "turn_left",
  "turn_right",
  "spin",
  "kick_left",
  "kick_right",
  "side_kick_left",
  "side_kick_right",
] as const;
export type BodyAction = (typeof BODY_ACTIONS)[number];
export type JumpSupport = "both" | "left" | "right";
const LABELS: Record<BodyAction, string> = {
  walk: "Walk in place",
  run: "Run in place",
  walk_wave: "Walk and wave",
  run_wave: "Run and wave",
  jump: "Jump",
  bow: "Bow",
  crouch: "Crouch",
  kneel: "Kneel on both knees",
  lie_down: "Lie down on the floor",
  sit: "Sit on the floor",
  turn_left: "Turn left",
  turn_right: "Turn right",
  spin: "Spin",
  kick_left: "Kick with the left leg",
  kick_right: "Kick with the right leg",
  side_kick_left: "Side kick with the left leg",
  side_kick_right: "Side kick with the right leg",
};
type Keys = [number, number][];
const constant = (value: number): Curve => ({ kind: "constant", value });
const keys = (points: Keys): Curve => ({
  kind: "keys",
  interpolation: "smooth",
  points,
});
const scaled = (points: Keys, amount: number): Curve =>
  keys(points.map(([time, value]) => [time, value * amount]));
const group = (
  id: string,
  label: string,
  children: MotionNode[],
): GroupNode => ({ id, label, kind: "parallel", children });

// Shift and repeat a closed phrase without baking its joint trajectories to frames.
function periodic(points: Keys, cycles: number, phase = 0): Curve {
  const source = keys(points);
  const values = new Map<number, number>([
    [0, sampleCurve(source, phase)],
    [1, sampleCurve(source, phase)],
  ]);
  for (let cycle = -1; cycle <= cycles; cycle++)
    for (const [progress, value] of points) {
      const time = (cycle + progress - phase) / cycles;
      if (time > 1e-10 && time < 1 - 1e-10) values.set(time, value);
    }
  return keys([...values].sort(([a], [b]) => a - b));
}

/** Whole-body motions are authored as curves and foot targets, like the dance tree. */
export function createBodyAction(
  action: BodyAction,
  count = 1,
  bpm = 108,
  support?: JumpSupport,
): MotionProgram {
  if (
    !BODY_ACTIONS.includes(action) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 8
  )
    throw new Error(
      "Choose a supported body action and a repetition count from 1 to 8.",
    );
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240)
    throw new Error("Choose a tempo from 30 to 240 BPM.");
  if (
    support !== undefined &&
    (action !== "jump" || !["both", "left", "right"].includes(support))
  )
    throw new Error("Choose both, left, or right support for a jump only.");
  if (action === "walk_wave" || action === "run_wave") {
    const program = waveHand(
      createBodyAction(action === "walk_wave" ? "walk" : "run", count, bpm),
      "right",
    );
    const title = `${LABELS[action]}${count > 1 ? ` · ${count} times` : ""}`;
    return { ...program, title, root: { ...program.root, label: title } };
  }
  const turning =
    action === "turn_left" || action === "turn_right" || action === "spin";
  const kickSide =
    action === "kick_left" || action === "side_kick_left"
      ? "left"
      : action === "kick_right" || action === "side_kick_right"
        ? "right"
        : undefined;
  const heldPosture =
    action === "sit" || action === "kneel" || action === "lie_down";
  const continuousCount = turning || heldPosture;
  const repetitions = continuousCount ? 1 : count;
  const duration =
    (((action === "jump" ? 2 : 4) * 60) / bpm) * (continuousCount ? count : 1);
  const feet: MotionNode[] = [],
    torso: MotionNode[] = [],
    arms: MotionNode[] = [];
  const rotation = (
    id: string,
    target: string,
    axis: Axis,
    curve: Curve,
  ): CurveNode => ({
    id,
    label: `${target.replaceAll("_", " ")} · ${axis}`,
    kind: "curve",
    target,
    axis,
    channel: "rotation",
    duration,
    curve,
  });
  const position = (
    id: string,
    target: string,
    axis: Axis,
    curve: Curve,
  ): CurveNode => ({
    ...rotation(id, target, axis, curve),
    channel: "position",
  });
  const locomotion = action === "walk" || action === "run";
  const effort: Keys =
    heldPosture
      ? [
          ...new Map(
            Array.from({ length: count }, (_, index) => {
              const shape: Keys =
                index === count - 1
                  ? [
                      [0, 0],
                      [0.1, 0],
                      [0.5, 1],
                      [1, 1],
                    ]
                  : [
                      [0, 0],
                      [0.1, 0],
                      [0.4, 1],
                      [0.55, 1],
                      [0.92, 0],
                      [1, 0],
                    ];
              return shape.map(([time, value]): [number, number] => [
                (index + time) / count,
                value,
              ]);
            }).flat(),
          ).entries(),
        ]
      : action === "jump"
        ? [
            [0, 0],
            [0.15, 1],
            [0.27, 0],
            [0.65, 0],
            [0.78, 0.65],
            [1, 0],
          ]
        : [
            [0, 0],
            [0.12, 0],
            [0.43, 1],
            [0.63, 1],
            [0.92, 0],
            [1, 0],
          ];
  if (locomotion) {
    const running = action === "run",
      cycles = running ? 4 : 2;
    const stride: Keys = running
      ? [
          [0, 0.27],
          [0.08, 0.2],
          [0.27, -0.22],
          [0.42, -0.24],
          [0.6, -0.03],
          [0.85, 0.26],
          [1, 0.27],
        ]
      : [
          [0, 0.15],
          [0.45, -0.15],
          [0.55, -0.16],
          [0.72, -0.04],
          [0.92, 0.14],
          [1, 0.15],
        ];
    const lift: Keys = running
      ? [
          [0, 0],
          [0.27, 0],
          [0.42, 0.17],
          [0.6, 0.3],
          [0.85, 0.12],
          [1, 0],
        ]
      : [
          [0, 0],
          [0.45, 0],
          [0.55, 0.01],
          [0.72, 0.1],
          [0.92, 0.04],
          [1, 0],
        ];
    const bounce: Keys = running
      ? [
          [0, -0.055],
          [0.18, -0.025],
          [0.4, 0.045],
          [0.5, -0.055],
          [0.68, -0.025],
          [0.9, 0.045],
          [1, -0.055],
        ]
      : [
          [0, -0.03],
          [0.25, -0.015],
          [0.5, -0.03],
          [0.75, -0.015],
          [1, -0.03],
        ];
    torso.push(position("torso.bounce", "root", "y", periodic(bounce, cycles)));
    torso.push(
      position("torso.sway", "root", "x", {
        kind: "sine",
        amplitude: running ? 0.012 : 0.018,
        cycles,
        phase: 0.25,
      }),
    );
    torso.push(rotation("torso.lean", "hips", "x", constant(running ? 10 : 3)));
    torso.push(
      rotation("torso.counter", "chest", "y", {
        kind: "sine",
        amplitude: running ? 8 : 4,
        cycles,
      }),
    );
    for (const side of ["left", "right"] as const) {
      const phase = side === "left" ? 0 : 0.5,
        sign = side === "left" ? 1 : -1;
      feet.push(
        group(`feet.${side}`, `${side} foot · contact and swing`, [
          position(`feet.${side}.x`, `${side}_foot_ik`, "x", constant(0)),
          position(
            `feet.${side}.y`,
            `${side}_foot_ik`,
            "y",
            periodic(lift, cycles, phase),
          ),
          position(
            `feet.${side}.z`,
            `${side}_foot_ik`,
            "z",
            periodic(stride, cycles, phase),
          ),
        ]),
      );
      arms.push(
        group(`arms.${side}`, `${side} arm · counter-swing`, [
          rotation(`arms.${side}.shoulder.x`, `${side}_shoulder`, "x", {
            kind: "sine",
            amplitude: running ? 34 : 19,
            cycles,
            phase: phase + 0.25,
            offset: running ? -4 : 0,
          }),
          rotation(
            `arms.${side}.shoulder.z`,
            `${side}_shoulder`,
            "z",
            constant(sign * (running ? 9 : 5)),
          ),
          rotation(`arms.${side}.elbow`, `${side}_elbow`, "x", {
            kind: "sine",
            amplitude: running ? 9 : 7,
            cycles,
            phase: phase + 0.25,
            offset: running ? -85 : -18,
          }),
          rotation(
            `arms.${side}.wrist`,
            `${side}_wrist`,
            "x",
            constant(running ? -5 : 0),
          ),
        ]),
      );
    }
  } else if (turning) {
    const angle = action === "spin" ? 360 : action === "turn_left" ? 90 : -90;
    const yaw: Keys = [
      ...new Map(
        Array.from({ length: count }, (_, index) =>
          (
            [
              [0, 0],
              [0.1, 0],
              [0.85, 1],
              [1, 1],
            ] as Keys
          ).map(([time, amount]): [number, number] => [
            (index + time) / count,
            (index + amount) * angle,
          ]),
        ).flat(),
      ).entries(),
    ];
    torso.push(rotation("torso.turn", "root", "y", keys(yaw)));
    for (const side of ["left", "right"] as const) {
      feet.push(
        rotation(`feet.${side}.neutral`, `${side}_ankle`, "x", constant(0)),
      );
      arms.push(
        rotation(
          `arms.${side}.open`,
          `${side}_shoulder`,
          "z",
          constant((side === "left" ? 1 : -1) * (action === "spin" ? 48 : 0)),
        ),
      );
    }
  } else if (action === "kneel") {
    torso.push(position("torso.height", "root", "y", scaled(effort, -0.48)));
    torso.push(position("torso.balance", "root", "z", scaled(effort, 0.08)));
    torso.push(rotation("torso.hinge", "hips", "x", scaled(effort, 5)));
    for (const side of ["left", "right"] as const) {
      feet.push(group(`feet.${side}`, `${side} leg · knee down, foot behind`, [
        position(`feet.${side}.x`, `${side}_foot_ik`, "x", constant(0)),
        position(`feet.${side}.y`, `${side}_foot_ik`, "y", constant(0)),
        position(`feet.${side}.z`, `${side}_foot_ik`, "z", scaled(effort, -0.42)),
        position(`feet.${side}.knee.y`, `${side}_knee_pole`, "y", scaled(effort, -1)),
        position(`feet.${side}.knee.z`, `${side}_knee_pole`, "z", constant(1)),
      ]));
      arms.push(group(`arms.${side}`, `${side} arm · relaxed by the thighs`, [
        rotation(`arms.${side}.shoulder`, `${side}_shoulder`, "x", scaled(effort, -12)),
        rotation(`arms.${side}.elbow`, `${side}_elbow`, "x", scaled(effort, -12)),
      ]));
    }
  } else if (action === "lie_down") {
    // Descend into a seated tuck, then extend the legs while reclining. The
    // root and leg curves remain editable; no baked animation or new solver.
    const phase = (node: CurveNode): MotionNode => {
      if (count === 1) return node;
      if (node.curve.kind !== "keys") throw new Error("A posture phase needs keyframes.");
      const phraseDuration = duration / count;
      return {
        id: node.id,
        label: node.label,
        kind: "sequence",
        children: [
          {
            id: `${node.id}.cycles`, label: "Lie down and recover", kind: "repeat", count: count - 1,
            children: [
              { ...node, id: `${node.id}.descend`, duration: phraseDuration * .6 },
              {
                ...node, id: `${node.id}.recover`, duration: phraseDuration * .4,
                curve: keys(node.curve.points.map(([time, value]): [number, number] => [1 - time, value]).reverse()),
              },
            ],
          },
          { ...node, id: `${node.id}.settle`, duration: phraseDuration },
        ],
      };
    };
    const recline: Keys = [[0, 0], [.35, 0], [.8, -90], [1, -90]];
    const hip: Keys = [[0, 0], [.35, -65], [.6, -50], [.8, 0], [1, 0]];
    const knee: Keys = [[0, 0], [.35, 130], [.6, 95], [.8, 0], [1, 0]];
    // Match the root's height to the extending legs. These neutral leg lengths
    // are shared by the bundled characters; holding the ankle plane prevents
    // the reclining transition from sweeping the feet through the floor.
    const floorHeight: Keys = Array.from({ length: 81 }, (_, index) => {
      const time = index / 80, radians = Math.PI / 180;
      const root = sampleCurve(keys(recline), time) * radians;
      const upper = root + sampleCurve(keys(hip), time) * radians;
      const lower = upper + sampleCurve(keys(knee), time) * radians;
      const ankle = .9491 + .0221 * Math.cos(root) - .007 * Math.sin(root)
        - .4288 * Math.cos(upper) + .0001 * Math.sin(upper)
        - .4559 * Math.cos(lower) + .0514 * Math.sin(lower);
      return [time, .0865 - ankle];
    });
    torso.push(phase(rotation("torso.recline", "hips", "x", keys(recline))));
    torso.push(phase(position("torso.height", "root", "y", keys(floorHeight))));
    torso.push(phase(position("torso.center", "root", "z", keys([[0, 0], [.35, -.1], [.8, -.2], [1, -.2]]))));
    for (const side of ["left", "right"] as const) {
      feet.push(group(`feet.${side}`, `${side} leg · sit, extend, rest`, [
        phase(rotation(`feet.${side}.hip`, `${side}_hip`, "x", keys(hip))),
        phase(rotation(`feet.${side}.knee`, `${side}_knee`, "x", keys(knee))),
        phase(rotation(`feet.${side}.ankle`, `${side}_ankle`, "x", keys([[0, 0], [.35, -65], [.6, -45], [.8, 0], [1, 0]]))),
      ]));
      arms.push(group(`arms.${side}`, `${side} arm · balance then rest`, [
        phase(rotation(`arms.${side}.shoulder.x`, `${side}_shoulder`, "x", keys([[0, 0], [.35, -30], [.65, -20], [.85, 0], [1, 0]]))),
        phase(rotation(`arms.${side}.shoulder.z`, `${side}_shoulder`, "z", keys([[0, 0], [.35, (side === "left" ? 1 : -1) * 15], [.85, (side === "left" ? 1 : -1) * 8], [1, (side === "left" ? 1 : -1) * 8]]))),
      ]));
    }
  } else if (kickSide) {
    const lateral = action.startsWith("side_kick_");
    torso.push(
      position(
        "torso.balance.x",
        "root",
        "x",
        scaled(effort, kickSide === "left" ? -0.055 : 0.055),
      ),
    );
    torso.push(position("torso.balance.y", "root", "y", scaled(effort, -0.04)));
    torso.push(rotation("torso.counterlean", "hips", lateral ? "z" : "x", scaled(effort, lateral ? (kickSide === "left" ? 10 : -10) : -8)));
    for (const side of ["left", "right"] as const) {
      const kicking = side === kickSide;
      feet.push(
        group(
          `feet.${side}`,
          `${side} foot · ${kicking ? "chamber, kick, retract" : "support"}`,
          [
            position(`feet.${side}.x`, `${side}_foot_ik`, "x", kicking && lateral ? scaled([
              [0, 0], [.12, 0], [.3, .08], [.47, .72], [.56, .72], [.72, .08], [.9, 0], [1, 0],
            ], side === "left" ? 1 : -1) : constant(0)),
            position(
              `feet.${side}.y`,
              `${side}_foot_ik`,
              "y",
              kicking
                ? keys([
                    [0, 0],
                    [0.12, 0],
                    [0.3, 0.28],
                    [0.47, 0.5],
                    [0.56, 0.5],
                    [0.72, 0.24],
                    [0.9, 0],
                    [1, 0],
                  ])
                : constant(0),
            ),
            position(
              `feet.${side}.z`,
              `${side}_foot_ik`,
              "z",
              kicking && !lateral
                ? keys([
                    [0, 0],
                    [0.12, 0],
                    [0.3, 0.1],
                    [0.47, 0.8],
                    [0.56, 0.8],
                    [0.72, 0.15],
                    [0.9, 0],
                    [1, 0],
                  ])
                : constant(0),
            ),
          ],
        ),
      );
      arms.push(
        group(`arms.${side}`, `${side} arm · guard`, [
          rotation(
            `arms.${side}.shoulder.x`,
            `${side}_shoulder`,
            "x",
            scaled(effort, -25),
          ),
          rotation(
            `arms.${side}.shoulder.z`,
            `${side}_shoulder`,
            "z",
            scaled(effort, (side === "left" ? 1 : -1) * 16),
          ),
          rotation(
            `arms.${side}.elbow`,
            `${side}_elbow`,
            "x",
            scaled(effort, -65),
          ),
        ]),
      );
    }
  } else {
    const height: Curve =
      action === "jump"
        ? keys([
            [0, 0],
            [0.15, -0.13],
            [0.27, 0.05],
            [0.44, 0.34],
            [0.61, 0.11],
            [0.7, 0],
            [0.78, -0.095],
            [1, 0],
          ])
        : scaled(
            effort,
            action === "sit" ? -0.7 : action === "crouch" ? -0.36 : -0.035,
          );
    torso.push(position("torso.height", "root", "y", height));
    torso.push(
      position(
        "torso.balance",
        "root",
        "z",
        scaled(
          effort,
          action === "sit"
            ? -0.1
            : action === "bow"
              ? -0.065
              : action === "crouch"
                ? -0.09
                : -0.018,
        ),
      ),
    );
    torso.push(
      rotation(
        "torso.hinge",
        "hips",
        "x",
        scaled(
          effort,
          action === "sit"
            ? 4
            : action === "bow"
              ? 20
              : action === "crouch"
                ? 17
                : 12,
        ),
      ),
    );
    torso.push(
      rotation(
        "torso.spine",
        "spine",
        "x",
        scaled(effort, action === "bow" ? 19 : action === "crouch" ? 10 : 5),
      ),
    );
    torso.push(
      rotation(
        "torso.chest",
        "chest",
        "x",
        scaled(effort, action === "bow" ? 12 : 0),
      ),
    );
    torso.push(
      rotation(
        "torso.head",
        "head",
        "x",
        scaled(effort, action === "bow" ? 8 : action === "crouch" ? -10 : -3),
      ),
    );
    const airborne: Curve =
      action === "jump"
        ? keys([
            [0, 0],
            [0.23, 0],
            [0.28, 0.075],
            [0.44, 0.38],
            [0.6, 0.17],
            [0.7, 0],
            [1, 0],
          ])
        : constant(0);
    const reach: Curve =
      action === "jump"
        ? keys([
            [0, 0],
            [0.15, 28],
            [0.32, -65],
            [0.44, -80],
            [0.61, -42],
            [0.78, -10],
            [1, 0],
          ])
        : scaled(
            effort,
            action === "sit" ? -25 : action === "crouch" ? -62 : -22,
          );
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      feet.push(
        group(
          `feet.${side}`,
          `${side} foot · ${action === "jump" ? "takeoff and landing" : "planted"}`,
          [
            position(`feet.${side}.x`, `${side}_foot_ik`, "x", constant(0)),
            position(`feet.${side}.y`, `${side}_foot_ik`, "y", airborne),
            position(
              `feet.${side}.z`,
              `${side}_foot_ik`,
              "z",
              action === "sit" ? scaled(effort, 0.4) : constant(0),
            ),
          ],
        ),
      );
      arms.push(
        group(
          `arms.${side}`,
          `${side} arm · ${action === "bow" ? "relaxed at the side" : "balance"}`,
          [
            rotation(`arms.${side}.shoulder.x`, `${side}_shoulder`, "x", reach),
            rotation(
              `arms.${side}.shoulder.z`,
              `${side}_shoulder`,
              "z",
              scaled(effort, sign * (action === "bow" ? 4 : 10)),
            ),
            rotation(
              `arms.${side}.elbow`,
              `${side}_elbow`,
              "x",
              scaled(effort, action === "bow" ? -7 : -25),
            ),
          ],
        ),
      );
    }
  }
  const repeat = (id: string, label: string, children: MotionNode[]) =>
    group(
      id,
      label,
      repetitions === 1
        ? children
        : [
            {
              id: `${id}.repetitions`,
              label: `Repeat ${repetitions} times`,
              kind: "repeat",
              count: repetitions,
              children: [group(`${id}.phrase`, label, children)],
            },
          ],
    );
  const singleFoot = action === "jump" && support && support !== "both";
  const title = `${singleFoot ? `Jump on the ${support} foot` : LABELS[action]}${count > 1 ? ` · ${count} times` : ""}`;
  const supportNodes: MotionNode[] = [];
  if (singleFoot) {
    const freeSide = support === "left" ? "right" : "left";
    // Prepare once, keep the free foot tucked between hops, then recover once.
    // The repeated jump tracks still own takeoff/landing for the support foot.
    const balance: Keys = [
      [0, 0],
      [0.13 / count, 1],
      [(count - 0.12) / count, 1],
      [1, 0],
    ];
    const continuous = (node: CurveNode): CurveNode => ({
      ...node,
      duration: duration * count,
    });
    supportNodes.push(
      group("jump_support", `Balance over the ${support} foot`, [
        continuous(
          position(
            "jump_support.weight",
            "root",
            "x",
            scaled(balance, support === "left" ? 0.09 : -0.09),
          ),
        ),
        continuous(
          position(
            "jump_support.free_foot.height",
            `${freeSide}_foot_ik`,
            "y",
            scaled(balance, 0.24),
          ),
        ),
        continuous(
          position(
            "jump_support.free_foot.tuck",
            `${freeSide}_foot_ik`,
            "z",
            scaled(balance, -0.16),
          ),
        ),
      ]),
    );
  }
  const program: MotionProgram = {
    version: 2,
    title,
    bpm,
    // Finite actions should not become a repeating background when a new hand
    // skill is requested. Cyclic gaits remain composable, like dance footwork.
    root: group(locomotion && count === 1 ? "motion" : "body_action", title, [
      repeat(
        "feet",
        locomotion
          ? "Footwork · alternating strides"
          : "Footwork · support and landing",
        feet,
      ),
      repeat("torso", "Body · weight and balance", torso),
      repeat("arms", "Arms · coordinated movement", arms),
      ...supportNodes,
      group("details", "Joint details", [
        {
          ...rotation("details.neutral", "neck", "x", constant(0)),
          duration: duration * repetitions,
        },
      ]),
    ]),
  };
  compileMotion(program);
  return program;
}

export interface BodyActionStep {
  action: BodyAction;
  count: number;
  support?: JumpSupport;
}

/** Recover a completed floor recline along its supported path before a new action. */
export function createPostureRecovery(current: MotionProgram): MotionProgram | undefined {
  const timeline = compileMotion(current);
  const final = sampleTimeline(timeline, timeline.duration);
  const value = (target: string, axis: Axis, channel = "rotation") =>
    final.find(pose => pose.target === target && pose.axis === axis && pose.channel === channel)?.value ?? 0;
  if (Math.abs(value("hips", "x") + 90) > 1e-6) return undefined;
  const reference = withFacing(createBodyAction("lie_down", 1, current.bpm), value("root", "y"));
  const referenceTimeline = compileMotion(reference);
  const referencePose = sampleTimeline(referenceTimeline, referenceTimeline.duration);
  // An intervening held joint gesture can replace every authored node ID.
  // Recognize the actual reclined pelvis/floor position instead of its history.
  const referenceHeight = referencePose.find(pose => pose.target === "root" && pose.channel === "position" && pose.axis === "y")!.value;
  if (Math.abs(value("root", "y", "position") - referenceHeight) > 1e-6) return undefined;
  const recovery = reverseCurrentMotion(reference);
  const channelKey = (pose: PoseValue) => `${pose.target}.${pose.channel}.${pose.axis}`;
  const requested = new Map(final.map(pose => [channelKey(pose), pose]));
  const baseline = new Map(referencePose.map(pose => [channelKey(pose), pose]));
  const corrections: CurveNode[] = [...new Set([...requested.keys(), ...baseline.keys()])].flatMap(key => {
    const delta = (requested.get(key)?.value ?? 0) - (baseline.get(key)?.value ?? 0);
    if (Math.abs(delta) < 1e-9) return [];
    const pose = requested.get(key) ?? baseline.get(key)!;
    return [{ id: `recovery_modifier.${key}`, label: "Release the preceding joint pose", kind: "curve",
      target: pose.target, axis: pose.axis, channel: pose.channel, duration: referenceTimeline.duration,
      curve: keys([[0, delta], [1, 0]]) }];
  });
  const root = recovery.root as GroupNode;
  const armTarget = (target: string) => /^(left|right)_(clavicle|shoulder|elbow|wrist|thumb|index|middle|ring|pinky)(_|$)/.test(target);
  recovery.root = { ...root, children: root.children.map(node => {
    const added = corrections.filter(curve => node.id === (armTarget(curve.target) ? "arms" : "torso"));
    return added.length && node.kind === "parallel" ? { ...node, children: [...node.children, ...added] } : node;
  }) };
  const visit = (node: MotionNode): MotionNode => {
    const id = `posture_recovery.${node.id}`;
    if (node.kind === "curve" || node.kind === "contact") return { ...node, id, duration: node.duration * .4 };
    return { ...node, id, children: node.children.map(visit) };
  };
  return { ...recovery, title: "Rise from the floor", root: visit(recovery.root) };
}

function affineCurve(curve: Curve, scale = 1, offset = 0): Curve {
  if (curve.kind === "constant")
    return { ...curve, value: curve.value * scale + offset };
  if (curve.kind === "sine")
    return {
      ...curve,
      amplitude: curve.amplitude * scale,
      offset: (curve.offset ?? 0) * scale + offset,
    };
  return {
    ...curve,
    points: curve.points.map(([time, value]) => [time, value * scale + offset]),
  };
}

// Later actions keep the facing established by an earlier turn. Root positions
// remain stage coordinates; foot trajectories follow the rig's rotated IK frame.
function withFacing(program: MotionProgram, heading: number): MotionProgram {
  if (heading === 0) return program;
  const radians = (heading * Math.PI) / 180,
    cosine = Math.cos(radians),
    sine = Math.sin(radians);
  let hasYaw = false;
  const visit = (node: MotionNode): MotionNode => {
    if (node.kind === "contact") return node;
    if (node.kind !== "curve")
      return { ...node, children: node.children.map(visit) };
    if (node.target !== "root") return node;
    if (node.channel === "rotation" && node.axis === "y") {
      hasYaw = true;
      return { ...node, curve: affineCurve(node.curve, 1, heading) };
    }
    if (node.channel !== "position" || node.axis === "y") return node;
    return group(`${node.id}.heading`, node.label, [
      {
        ...node,
        id: `${node.id}.heading.x`,
        axis: "x",
        curve: affineCurve(node.curve, node.axis === "x" ? cosine : sine),
      },
      {
        ...node,
        id: `${node.id}.heading.z`,
        axis: "z",
        curve: affineCurve(node.curve, node.axis === "x" ? -sine : cosine),
      },
    ]);
  };
  const root = visit(program.root);
  if (!hasYaw && root.kind === "parallel") {
    const torso = root.children.find((node) => node.id === "torso");
    if (torso?.kind !== "parallel")
      throw new Error("The body action needs its torso branch.");
    torso.children.push({
      id: "torso.facing",
      kind: "curve",
      label: "Keep the current facing",
      target: "root",
      channel: "rotation",
      axis: "y",
      duration: compileMotion(program).duration,
      curve: constant(heading),
    });
  }
  return { ...program, root };
}

function transitionPose(
  id: string,
  from: PoseValue[],
  to: PoseValue[],
  duration: number,
): GroupNode {
  const key = (pose: PoseValue) =>
    `${pose.target}.${pose.channel}.${pose.axis}`;
  const start = new Map(from.map((pose) => [key(pose), pose]));
  const end = new Map(to.map((pose) => [key(pose), pose]));
  return group(
    id,
    "Settle into the next action",
    [...new Set([...start.keys(), ...end.keys()])].map((channel) => {
      const ref = end.get(channel) ?? start.get(channel)!;
      return {
        id: `${id}.${channel}`,
        kind: "curve",
        label: `${ref.target.replaceAll("_", " ")} · transition`,
        target: ref.target,
        axis: ref.axis,
        channel: ref.channel,
        duration,
        curve: keys([
          [0, start.get(channel)?.value ?? 0],
          [1, end.get(channel)?.value ?? 0],
        ]),
      };
    }),
  );
}

/** Keep every requested action in order, with authored transitions rather than last-line wins. */
export function createBodySequence(
  steps: BodyActionStep[],
  bpm = 108,
): MotionProgram {
  if (
    !steps.length ||
    steps.length > 4 ||
    steps.reduce((total, step) => total + step.count, 0) > 16
  )
    throw new Error(
      "Use one to four body actions with at most sixteen repetitions in total.",
    );
  if (steps.length === 1)
    return createBodyAction(
      steps[0].action,
      steps[0].count,
      bpm,
      steps[0].support,
    );
  let heading = 0;
  const programs = steps.map(({ action, count, support }) => {
    const program = withFacing(
      createBodyAction(action, count, bpm, support),
      heading,
    );
    if (action === "turn_left") heading += 90 * count;
    if (action === "turn_right") heading -= 90 * count;
    if (action === "spin") heading += 360 * count;
    return program;
  });
  const children: MotionNode[] = [],
    armPhases: MotionNode[] = [];
  for (const [index, program] of programs.entries()) {
    if (index) {
      const recovery = createPostureRecovery(programs[index - 1]);
      if (recovery) {
        const prefixRecovery = (node: MotionNode): MotionNode => {
          const id = `body_recovery.${index}.${node.id}`;
          return node.kind === "curve" || node.kind === "contact" ? { ...node, id } : { ...node, id, children: node.children.map(prefixRecovery) };
        };
        const recover = prefixRecovery(recovery.root) as GroupNode;
        const recoverArms = recover.children.filter(node => node.id.endsWith(".posture_recovery.arms"));
        children.push({ ...recover, children: recover.children.filter(node => !recoverArms.includes(node)) });
        armPhases.push(group(`arms.recovery.${index}`, recovery.title, recoverArms));
      }
      const previous = compileMotion(recovery ?? programs[index - 1]),
        next = compileMotion(program);
      const transition = transitionPose(
        `body_transition.${index}`,
        sampleTimeline(previous, previous.duration),
        sampleTimeline(next, 0),
        (0.28 * 108) / bpm,
      );
      const armTarget = (node: MotionNode) =>
        node.kind === "curve" &&
        /^(left|right)_(clavicle|shoulder|elbow|wrist|thumb|index|middle|ring|pinky)(_|$)/.test(
          node.target,
        );
      children.push({
        ...transition,
        children: transition.children.filter((node) => !armTarget(node)),
      });
      armPhases.push({
        ...transition,
        id: `${transition.id}.arms`,
        children: transition.children.filter(armTarget),
      });
    }
    const prefix = (node: MotionNode): MotionNode =>
      node.kind === "curve" || node.kind === "contact"
        ? { ...node, id: `body_step.${index}.${node.id}` }
        : {
            ...node,
            id: `body_step.${index}.${node.id}`,
            children: node.children.map(prefix),
          };
    const phase = prefix(program.root) as GroupNode;
    const isArmBranch = (node: MotionNode) =>
      node.id === `body_step.${index}.arms` ||
      node.id === `body_step.${index}.hello_wave`;
    children.push({
      ...phase,
      children: phase.children.filter((node) => !isArmBranch(node)),
    });
    armPhases.push(
      group(
        `arms.phase.${index}`,
        phase.label,
        phase.children.filter(isArmBranch),
      ),
    );
  }
  const title = programs.map((program) => program.title).join(" → ");
  const result: MotionProgram = {
    version: 2,
    title,
    bpm,
    root: group("body_sequence", title, [
      {
        id: "body_phases",
        kind: "sequence",
        label: "Body actions in order",
        children,
      },
      group("arms", "Arms · coordinated with each action", [
        {
          id: "arms.phases",
          kind: "sequence",
          label: "Arm actions in order",
          children: armPhases,
        },
      ]),
    ]),
  };
  compileMotion(result);
  return result;
}
