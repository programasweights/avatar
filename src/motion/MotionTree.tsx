import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import type { MotionNode, MotionProgram, Timeline } from "./types";
import { findNode, sampleTimeline } from "./engine";
import { JOINT_LABEL } from "./rig";

export function nodePath(root: MotionNode, id: string): MotionNode[] {
  if (root.id === id) return [root];
  if (root.kind === "curve" || root.kind === "contact") return [];
  for (const child of root.children) {
    const path = nodePath(child, id);
    if (path.length) return [root, ...path];
  }
  return [];
}

export function shortNodeLabel(node: MotionNode): string {
  if (node.kind === "curve") {
    const finger =
      /^(left|right)_(thumb|index|middle|ring|pinky)_([123])$/.exec(
        node.target,
      );
    if (finger)
      return `${["Base", "Middle", "Tip"][Number(finger[3]) - 1]} joint`;
    return JOINT_LABEL(node.target);
  }
  const finger = /(?:^|\.)(thumb|index|middle|ring|pinky)$/.exec(node.id);
  if (finger)
    return `${finger[1][0].toUpperCase()}${finger[1].slice(1)} finger`;
  return node.label;
}

function movingTargets(timeline: Timeline, time: number) {
  const key = (v: { target: string; channel: string; axis: string }) =>
    `${v.target}.${v.channel}.${v.axis}`;
  const before = new Map(
    sampleTimeline(timeline, Math.max(0, time - 0.02)).map((v) => [
      key(v),
      v.value,
    ]),
  );
  return new Set(
    sampleTimeline(timeline, Math.min(timeline.duration, time + 0.02))
      .filter(
        (v) =>
          Math.abs(v.value - (before.get(key(v)) ?? 0)) >
          (v.channel === "rotation" ? 0.12 : 0.0001),
      )
      .map((v) => v.target),
  );
}

// Show the moving branches first. The full tree retains every pose and camera
// track; the compact view only folds setup and single-child wrappers away.
function interesting(node: MotionNode): boolean {
  if (/^editing\.freeze\.\d+$/.test(node.id)) return false;
  if (node.kind === "contact") return true;
  if (node.kind === "curve")
    return (
      node.curve.kind !== "constant" && !node.target.endsWith("_hand_camera")
    );
  return node.children.some(interesting);
}
function childrenOf(node: MotionNode, full: boolean): MotionNode[] {
  if (node.kind === "curve" || node.kind === "contact") return [];
  if (full) return node.children;
  const moving = node.children.filter(interesting);
  return (moving.length ? moving : node.children).flatMap((child) => {
    if (child.kind === "curve" || child.kind === "contact") return [child];
    const descendants = child.children.filter(interesting);
    if (descendants.length === 1) return childrenOf(child, false);
    return [child];
  });
}

function Row({
  node,
  selected,
  moving,
  full,
  depth,
  onSelect,
  forceOpen,
}: {
  node: MotionNode;
  selected: string;
  moving: Set<string>;
  full: boolean;
  depth: number;
  onSelect: (id: string) => void;
  forceOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(!!forceOpen);
  const children = childrenOf(node, full);
  const containsSelection = nodePath(node, selected).length > 1;
  const open = expanded;
  useEffect(() => {
    if (containsSelection) setExpanded(true);
  }, [selected, containsSelection]);
  useEffect(() => {
    if (forceOpen) setExpanded(true);
  }, [forceOpen]);
  const changing = (n: MotionNode): boolean =>
    n.kind === "curve"
      ? moving.has(n.target)
      : n.kind === "contact"
        ? false
        : n.children.some(changing);
  return (
    <div className="motion-tree-node">
      <div
        className={`live-tree-row ${selected === node.id ? "selected" : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {children.length ? (
          <button
            className="live-tree-expand"
            aria-label={`${open ? "Collapse" : "Expand"} ${shortNodeLabel(node)}`}
            aria-expanded={open}
            onClick={() => setExpanded(!open)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span
            className={`motion-dot ${changing(node) ? "active" : ""}`}
            aria-hidden="true"
          />
        )}
        <button
          className="live-tree-select"
          data-node-id={node.id}
          aria-pressed={selected === node.id}
          onClick={() => {
            onSelect(node.id);
            if (children.length) setExpanded(true);
          }}
        >
          <span>{shortNodeLabel(node)}</span>
          {node.kind === "curve" && full && (
            <small>{node.axis.toUpperCase()}</small>
          )}
          {children.length > 0 && (
            <span
              className={`motion-dot ${changing(node) ? "active" : ""}`}
              aria-hidden="true"
            />
          )}
        </button>
      </div>
      {open &&
        children.map((child) => (
          <Row
            key={child.id}
            node={child}
            selected={selected}
            moving={moving}
            full={full}
            depth={depth + 1}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

export default function MotionTree({
  program,
  timeline,
  time,
  playing,
  selected,
  onSelect,
  children,
}: {
  program: MotionProgram;
  timeline: Timeline;
  time: number;
  playing: boolean;
  selected: string;
  onSelect: (id: string) => void;
  children?: React.ReactNode;
}) {
  const [full, setFull] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = scroll.current;
    const button = viewport?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(selected)}"]`,
    );
    if (viewport && button)
      viewport.scrollTop +=
        button.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        4;
  }, [selected, full]);
  const moving = useMemo(
    () => (playing ? movingTargets(timeline, time) : new Set<string>()),
    [timeline, time, playing],
  );
  const ripple = !full ? findNode(program.root, "ripple.gesture") : undefined;
  const branches = childrenOf(ripple ?? program.root, full);
  return (
    <section className="live-motion-tree" aria-label="Live motion tree">
      <div className="live-tree-heading">
        <GitBranch size={16} />
        <h2>Motion tree</h2>
        <button onClick={() => setFull(!full)} aria-pressed={full}>
          {full ? "Motion branches" : "Full tree"}
        </button>
      </div>
      <p className="live-tree-hint">Select a finger. Change just that part.</p>
      <div
        ref={scroll}
        className="live-tree-scroll"
        key={`${program.root.id}:${full}`}
      >
        {(branches.length ? branches : [program.root]).map((node) => (
          <Row
            key={node.id}
            node={node}
            selected={selected}
            moving={moving}
            full={full}
            depth={0}
            onSelect={onSelect}
            forceOpen={!full && branches.length === 1}
          />
        ))}
      </div>
      {children}
    </section>
  );
}
