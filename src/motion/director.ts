import type { Axis, MotionProgram } from "./types";
import { compileMotion, findNode } from "./engine";
import {
  armBranch,
  changeTempo,
  createDance,
  jointOffset,
  replaceArms,
} from "./skills";
import type { ArmStyle, DanceStyle } from "./skills";
import { JOINTS, VALID_TARGETS } from "./rig";
import { composeDexterity } from "./composeDexterity";
import type { DexteritySkill } from "./dexterity";
import {
  changeMotionHand,
  reverseCurrentMotion,
  scaleTempo,
  waveHand,
} from "./relative";

export function validateRigProgram(program: MotionProgram) {
  const timeline = compileMotion(program);
  const targets = new Set([
    ...VALID_TARGETS,
    ...(program.props?.map((p) => p.id) ?? []),
  ]);
  if (program.props?.some((p) => VALID_TARGETS.has(p.id)))
    throw new Error("Prop IDs must not shadow rig joints.");
  for (const id of ["arms", "details"]) {
    const node = findNode(program.root, id);
    if (node && node.kind !== "parallel")
      throw new Error(
        `The reserved ${id} branch must be a parallel group. Use a different ID for other node kinds.`,
      );
  }
  for (const track of timeline.tracks) {
    if (!targets.has(track.target))
      throw new Error(`Unknown joint or target: ${track.target}`);
    if (
      track.target.endsWith("_hand_camera") &&
      (track.channel !== "rotation" || track.axis !== "y")
    )
      throw new Error(
        "Hand cameras use rotation.y: 0 degrees for the palm, 180 for the knuckles.",
      );
    if (track.target.endsWith("_ik") && track.channel !== "position")
      throw new Error("Foot IK targets use position channels.");
  }
  return timeline;
}
export function applyCommands(
  current: MotionProgram,
  raw: string,
): MotionProgram {
  const lines = raw
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 12)
    throw new Error("PAW returned an empty or oversized command program.");
  let next = current;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const [op, a, b, c] = parts;
    if (op === "unsupported")
      throw new Error(
        "That motion isn’t supported yet. Try a coin roll across your knuckles, a finger ripple, or an individual joint movement.",
      );
    if (
      op === "skill" &&
      parts.length === 4 &&
      ["finger_ripple", "finger_touches", "arm_wave", "coin_roll"].includes(
        a,
      ) &&
      ["left", "right"].includes(b) &&
      ["forward", "reverse"].includes(c)
    )
      next = composeDexterity(
        next,
        a as DexteritySkill,
        b as "left" | "right",
        c === "reverse",
      );
    else if (op === "reverse" && parts.length === 2 && a === "current")
      next = reverseCurrentMotion(next);
    else if (
      op === "hand" &&
      parts.length === 2 &&
      ["left", "right", "other"].includes(a)
    )
      next = changeMotionHand(next, a as "left" | "right" | "other");
    else if (
      op === "tempo_scale" &&
      parts.length === 2 &&
      /^\d+(\.\d+)?$/.test(a)
    )
      next = scaleTempo(next, Number(a));
    else if (
      op === "wave" &&
      parts.length === 2 &&
      ["left", "right"].includes(a)
    )
      next = waveHand(next, a as "left" | "right");
    else if (
      op === "dance" &&
      parts.length === 2 &&
      ["salsa", "cha_cha", "robot", "idle"].includes(a)
    )
      next = createDance(
        a as DanceStyle,
        a === "robot" ? "robot" : "natural",
        next.bpm,
      );
    else if (
      op === "arms" &&
      parts.length === 2 &&
      ["natural", "robot", "wave", "still"].includes(a)
    )
      next = replaceArms(next, a as ArmStyle);
    else if (
      op === "tempo" &&
      parts.length === 2 &&
      /^\d+$/.test(a) &&
      Number(a) >= 30 &&
      Number(a) <= 240
    )
      next = changeTempo(next, Number(a));
    else if (
      ["joint", "wiggle"].includes(op) &&
      parts.length === 4 &&
      Object.hasOwn(JOINTS, a) &&
      ["x", "y", "z"].includes(b) &&
      /^-?\d+(\.\d+)?$/.test(c) &&
      Math.abs(Number(c)) <= 180
    )
      next = jointOffset(next, a, b as Axis, Number(c), op === "wiggle");
    else throw new Error(`PAW returned an invalid command: ${line}`);
  }
  validateRigProgram(next);
  return next;
}
export async function directMotion(
  instruction: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    import.meta.env.VITE_DIRECT_API_URL || "/api/direct",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
      signal,
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : (data.detail?.message ??
          data.message ??
          "PAW inference is unavailable. The editor and examples still work."),
    );
  if (typeof data.output !== "string")
    throw new Error("PAW did not return a command program.");
  return data.output;
}
// Used by the inspector when an imported composition has no conventional arm
// branch: adding tracks remains explicit rather than quietly discarding edits.
export { armBranch };
