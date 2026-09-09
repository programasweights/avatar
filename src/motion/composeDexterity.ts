import { compileMotion, findNode } from "./engine";
import { createDexterity } from "./dexterityDirector";
import type { DexteritySkill } from "./dexterity";
import type { GroupNode, MotionNode, MotionProgram } from "./types";

// A language-directed trick replaces upper-body choreography while the existing
// root/feet tracks keep their exact timing. Repeat complete phrases to a shared
// boundary, so neither gait nor contacts disappear halfway through a loop.
export function composeDexterity(
  current: MotionProgram,
  skill: DexteritySkill,
  side: "left" | "right",
  reverse: boolean,
): MotionProgram {
  const study = createDexterity(skill, side, reverse, current.bpm);
  if (
    current.root.kind !== "parallel" ||
    study.root.kind !== "parallel" ||
    !current.root.children.some((n) => n.id === "arms") ||
    !current.root.children.some((n) => n.id === "details")
  ) {
    throw new Error(
      "This composition needs top-level arms and details branches to add a dexterity skill. Use a study button to start a new composition.",
    );
  }
  const previousDuration = compileMotion(current).duration;
  const studyDuration = compileMotion(study).duration;
  let previousCount = 0,
    studyCount = 0;
  for (let count = 1; count <= 32; count++) {
    const ratio = (count * previousDuration) / studyDuration;
    if (
      Math.abs(ratio - Math.round(ratio)) < 1e-7 &&
      ratio >= 1 &&
      ratio <= 32 &&
      count * previousDuration <= 600
    ) {
      previousCount = count;
      studyCount = Math.round(ratio);
      break;
    }
  }
  if (!previousCount)
    throw new Error(
      "These phrase lengths cannot share a loop without changing the footwork timing. Align their durations in Motion JSON or start a new study.",
    );
  const repeat = (
    node: MotionNode,
    count: number,
    prefix: string,
  ): MotionNode => {
    if (count === 1) return node;
    let id = `${prefix}.cycles`;
    while (findNode(current.root, id) || findNode(study.root, id)) id += "_";
    return {
      id,
      label: `${node.label} · repeat ${count}`,
      kind: "repeat",
      count,
      children: [node],
    };
  };
  const upper = (id: string): GroupNode => {
    const branch =
      study.root.kind === "parallel"
        ? study.root.children.find((n) => n.id === id)!
        : study.root;
    if (studyCount === 1) return branch as GroupNode;
    return {
      id,
      label: branch.label,
      kind: "parallel",
      children: [repeat({ ...branch, id: `${id}.phrase` }, studyCount, id)],
    };
  };
  const next: MotionProgram = {
    ...current,
    title: study.title,
    props: study.props,
    root: {
      ...current.root,
      label: study.title,
      children: current.root.children.map((node) =>
        node.id === "arms" || node.id === "details"
          ? upper(node.id)
          : repeat(node, previousCount, `continue.${node.id}`),
      ),
    },
  };
  compileMotion(next);
  return next;
}
