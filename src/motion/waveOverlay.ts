import { findNode } from "./engine";
import type { GroupNode, MotionProgram } from "./types";

export const WAVE_OVERLAY_ID = "hello_wave";

/** Recognize the serializable overlay shape, not an arbitrary imported ID. */
export function waveOverlay(program: MotionProgram): GroupNode | undefined {
  const node = findNode(program.root, WAVE_OVERLAY_ID);
  if (
    program.root.kind !== "parallel" ||
    node?.kind !== "parallel" ||
    !program.root.children.includes(node) ||
    node.children.length !== 9
  )
    return undefined;
  const channels = new Set<string>(),
    sides = new Set<string>();
  for (const child of node.children) {
    if (
      child.kind !== "curve" ||
      !/^(left|right)_(shoulder|elbow|wrist)$/.test(child.target) ||
      child.channel !== "rotation" ||
      child.blend !== "replace"
    )
      return undefined;
    channels.add(`${child.target}.${child.axis}`);
    sides.add(child.target.split("_")[0]);
  }
  return channels.size === 9 && sides.size === 1 ? node : undefined;
}

/** A new arm choreography supersedes a hello wave, but preserves custom content. */
export function removeWaveOverlay(program: MotionProgram): MotionProgram {
  const wave = waveOverlay(program);
  if (!wave || program.root.kind !== "parallel") return program;
  const children = program.root.children.filter((node) => node !== wave);
  if (!children.length)
    throw new Error("Keep a base motion before replacing the wave.");
  return { ...program, root: { ...program.root, children } };
}
