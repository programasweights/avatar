import { createDexterity } from "./dexterityDirector";
import { compileMotion, sampleTimeline } from "./engine";
import type { DexteritySkill } from "./dexterity";
import type {
  ContactNode,
  CurveNode,
  GroupNode,
  MotionNode,
  MotionProgram,
  PoseValue,
} from "./types";

type Side = "left" | "right";
export interface SequenceCue {
  id: string;
  label: string;
  instruction: string;
  start: number;
  duration: number;
  view: "palm" | "turn" | "knuckles";
}

export function getDexteritySequenceInstructions(
  side: Side = "left",
): string[] {
  return [
    `Make a wave from pinky to thumb on your ${side} hand.`,
    `Reverse the finger ripple on your ${side} hand.`,
    `Touch your ${side} thumb to each fingertip, index first.`,
    `Roll a coin across your ${side} knuckles.`,
  ];
}

export function defaultDexteritySequenceCommands(
  side: Side = "left",
): string[] {
  return [
    `skill finger_ripple ${side} forward`,
    `skill finger_ripple ${side} reverse`,
    `skill finger_touches ${side} forward`,
    `skill coin_roll ${side} forward`,
  ];
}

const parallel = (
  id: string,
  label: string,
  children: MotionNode[],
): GroupNode => ({ id, label, kind: "parallel", children });
const poseKey = (value: PoseValue) =>
  `${value.target}.${value.channel}.${value.axis}`;
const TIMING = {
  ripple: 2.4,
  reverse: 2.4,
  touches: 5,
  turn: 1.1,
  coin: 5.4,
  hold: 0.5,
};

function parseCommands(
  commands: string[],
  side: Side,
): { skill: DexteritySkill; side: Side; reverse: boolean }[] {
  const skills = [
    "finger_ripple",
    "finger_ripple",
    "finger_touches",
    "coin_roll",
  ];
  if (commands.length !== skills.length)
    throw new Error("The hand sequence needs exactly four PAW skill commands.");
  const parsed = commands.map((command, index) => {
    const match =
      /^skill (finger_ripple|finger_touches|coin_roll) (left|right) (forward|reverse)$/.exec(
        command.trim(),
      );
    if (!match || match[1] !== skills[index])
      throw new Error(
        `Sequence step ${index + 1} needs a ${skills[index]} command; received ${command}.`,
      );
    return {
      skill: match[1] as DexteritySkill,
      side: match[2] as Side,
      reverse: match[3] === "reverse",
    };
  });
  if (parsed.some((command) => command.side !== parsed[0].side))
    throw new Error(
      "Use one hand throughout the sequence so its movements stay in the same close-up.",
    );
  if (parsed[0].side !== side)
    throw new Error(
      `PAW returned the ${parsed[0].side} hand for the requested ${side} hand.`,
    );
  if (parsed.some((command, index) => command.reverse !== (index === 1)))
    throw new Error(
      "PAW must return the requested directions: forward, reverse, forward, forward.",
    );
  return parsed;
}

// Keep each authored subtree and its original joint keys. Selecting one repeat
// and retiming its leaves makes a concise performance without baking poses to
// frame samples; every curl, contact, and handoff remains directly editable.
function oneCycle(
  skill: DexteritySkill,
  side: Side,
  reverse: boolean,
  duration: number,
  prefix: string,
): MotionProgram {
  const original = createDexterity(skill, side, reverse);
  const cycle = compileMotion(original).duration / 2;
  const scale = duration / cycle;
  const visit = (node: MotionNode): MotionNode => {
    const id = `${prefix}.${node.id}`;
    if (node.kind === "curve" || node.kind === "contact")
      return { ...node, id, duration: Math.min(node.duration, cycle) * scale };
    return {
      ...node,
      id,
      ...(node.kind === "repeat" ? { count: 1 } : {}),
      children: node.children.map(visit),
    };
  };
  return { ...original, root: visit(original.root) };
}

function cameraCurve(
  id: string,
  side: Side,
  duration: number,
  from: number,
  to = from,
): CurveNode {
  return {
    id,
    label: "Camera · palm to knuckles",
    kind: "curve",
    target: `${side}_hand_camera`,
    axis: "y",
    channel: "rotation",
    duration,
    curve:
      from === to
        ? { kind: "constant", value: from }
        : {
            kind: "keys",
            interpolation: "smooth",
            points: [
              [0, from],
              [0.8, to],
              [1, to],
            ],
          },
  };
}

function endpoint(program: MotionProgram, end: boolean): PoseValue[] {
  const timeline = compileMotion(program);
  return sampleTimeline(timeline, end ? timeline.duration : 0);
}

function poseTransition(
  id: string,
  label: string,
  from: PoseValue[],
  to: PoseValue[],
  duration: number,
): GroupNode {
  const a = new Map(from.map((value) => [poseKey(value), value]));
  const b = new Map(to.map((value) => [poseKey(value), value]));
  const channels = [...new Set([...a.keys(), ...b.keys()])].sort();
  return parallel(
    id,
    label,
    channels.map((key) => {
      const reference = b.get(key) ?? a.get(key)!;
      return {
        id: `${id}.${key}`,
        kind: "curve",
        label: `${reference.target.replaceAll("_", " ")} · ${reference.axis}`,
        target: reference.target,
        axis: reference.axis,
        channel: reference.channel,
        duration,
        curve: {
          kind: "keys",
          interpolation: "smooth",
          points: [
            [0, a.get(key)?.value ?? 0],
            [1, b.get(key)?.value ?? 0],
          ],
        },
      };
    }),
  );
}

/** One continuous editable performance; commands are exact validated PAW outputs. */
export function createDexteritySequence(
  commands?: string[],
  side: Side = "left",
): { program: MotionProgram; cues: SequenceCue[] } {
  if (!["left", "right"].includes(side))
    throw new Error("Choose a left or right hand.");
  const parsed = parseCommands(
    commands ?? defaultDexteritySequenceCommands(side),
    side,
  );
  const instructions = getDexteritySequenceInstructions(side);
  const [ripple, reverse, touches, coin] = parsed.map((command, index) =>
    oneCycle(
      command.skill,
      command.side,
      command.reverse,
      [TIMING.ripple, TIMING.reverse, TIMING.touches, TIMING.coin][index],
      ["ripple", "reverse", "touches", "coin"][index],
    ),
  );
  const firstCoinContact = compileMotion(coin).contacts?.[0];
  const lastCoinContact = compileMotion(coin).contacts?.at(-1);
  if (
    firstCoinContact?.mode !== "prop_transfer" ||
    lastCoinContact?.mode !== "prop_transfer"
  )
    throw new Error("The coin study must contain editable prop handoffs.");

  const turn = poseTransition(
    "turn.pose",
    "Turn the palm down · settle the fingers",
    endpoint(touches, true),
    endpoint(coin, false),
    TIMING.turn,
  );
  const reveal: ContactNode = {
    id: "turn.coin",
    label: "Coin · fade in on the starting knuckle",
    kind: "contact",
    mode: "prop_transfer",
    prop: firstCoinContact.prop,
    from: firstCoinContact.from,
    to: firstCoinContact.to,
    rolls: firstCoinContact.rolls,
    rollOffset: firstCoinContact.rollOffset,
    duration: TIMING.turn,
    progress: { kind: "constant", value: 0 },
    visibility: {
      kind: "keys",
      interpolation: "smooth",
      points: [
        [0, 0],
        [0.7, 0],
        [0.95, 1],
        [1, 1],
      ],
    },
  };
  turn.children.push(
    reveal,
    cameraCurve("turn.camera", side, TIMING.turn, 0, 180),
  );
  const hold = poseTransition(
    "finish.pose",
    "Hold the final coin balance",
    endpoint(coin, true),
    endpoint(coin, true),
    TIMING.hold,
  );
  hold.children.push(
    {
      id: "finish.coin",
      label: "Coin · resting on the final knuckle",
      kind: "contact",
      mode: "prop_transfer",
      prop: lastCoinContact.prop,
      from: lastCoinContact.from,
      to: lastCoinContact.to,
      rolls: lastCoinContact.rolls,
      rollOffset: lastCoinContact.rollOffset,
      duration: TIMING.hold,
      progress: { kind: "constant", value: 1 },
    },
    cameraCurve("finish.camera", side, TIMING.hold, 180),
  );

  const phase = (
    id: string,
    label: string,
    source: MotionProgram,
    angle: number,
  ): GroupNode =>
    parallel(id, label, [
      source.root,
      cameraCurve(`${id}.camera`, side, compileMotion(source).duration, angle),
    ]);
  const startOf = (index: number) =>
    [
      0,
      TIMING.ripple,
      TIMING.ripple + TIMING.reverse,
      TIMING.ripple + TIMING.reverse + TIMING.touches,
      TIMING.ripple + TIMING.reverse + TIMING.touches + TIMING.turn,
    ][index];
  const labels = [
    "Pinky → thumb",
    "Thumb → pinky",
    "Thumb touches · index → pinky",
    "Turn the hand",
    "Roll across the knuckles",
  ];
  const cues: SequenceCue[] = [
    {
      id: "ripple",
      label: labels[0],
      instruction: instructions[0],
      start: startOf(0),
      duration: TIMING.ripple,
      view: "palm",
    },
    {
      id: "reverse",
      label: labels[1],
      instruction: instructions[1],
      start: startOf(1),
      duration: TIMING.reverse,
      view: "palm",
    },
    {
      id: "touches",
      label: labels[2],
      instruction: instructions[2],
      start: startOf(2),
      duration: TIMING.touches,
      view: "palm",
    },
    {
      id: "turn",
      label: labels[3],
      instruction: "",
      start: startOf(3),
      duration: TIMING.turn,
      view: "turn",
    },
    {
      id: "coin",
      label: labels[4],
      instruction: instructions[3],
      start: startOf(4),
      duration: TIMING.coin + TIMING.hold,
      view: "knuckles",
    },
  ];
  const program: MotionProgram = {
    version: 2,
    bpm: 108,
    title: `${side === "left" ? "Left" : "Right"} hand · from joints to dexterity`,
    props: coin.props,
    root: {
      id: "dexterity_sequence",
      label: "Finger wave → reverse → fingertip contacts → coin roll",
      kind: "sequence",
      children: [
        phase("sequence.ripple", labels[0], ripple, 0),
        phase("sequence.reverse", labels[1], reverse, 0),
        phase("sequence.touches", labels[2], touches, 0),
        turn,
        phase("sequence.coin", labels[4], coin, 180),
        hold,
      ],
    },
  };
  compileMotion(program);
  return { program, cues };
}
