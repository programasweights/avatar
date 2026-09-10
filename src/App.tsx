import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Code2,
  Download,
  Focus,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ScanLine,
  Undo2,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import MotionStage from "./motion/MotionStage";
import SiteHeader from "./SiteHeader";
import { drawRecordingFrame } from "./motion/recordingFrame";
import MotionTree, { nodePath, shortNodeLabel } from "./motion/MotionTree";
import {
  branchTargets,
  editingBlockReason,
  freezeTargets,
  restoreFrozen,
  resolveEditTarget,
  rotationMagnitude,
  withRotationMagnitude,
} from "./motion/editing";
import type { FrozenRotation } from "./motion/editing";
import CurveEditor from "./motion/CurveEditor";
import type { Transport } from "./motion/MotionStage";
import { initialCharacter, isGangnamExample, type CharacterLook } from "./motion/characters";
import { createGangnam } from "./motion/gangnam";
import type { Axis, Curve, CurveNode, MotionProgram } from "./motion/types";
import { findNode, sampleCurve, updateNode } from "./motion/engine";
import {
  applyCommands,
  directMotion,
  validateRigProgram,
} from "./motion/director";
import {
  changeTempo,
  createDance,
  findJointDetail,
  jointOffset,
  replaceArms,
} from "./motion/skills";
import { createDexterity } from "./motion/dexterityDirector";
import { currentMotionHand } from "./motion/relative";
import {
  createDexteritySequence,
  getDexteritySequenceInstructions,
} from "./motion/dexteritySequence";
import type { ArmStyle, DanceStyle } from "./motion/skills";
import { JOINT_LABEL, JOINTS } from "./motion/rig";
import "./motion/studio.css";
import "./motion/stageRecovery.css";

type DexterityStudy =
  | "finger_ripple"
  | "finger_touches"
  | "arm_wave"
  | "coin_roll";
type Hand = "left" | "right";
type SequenceCue = ReturnType<typeof createDexteritySequence>["cues"][number];

function sequenceCueAt(cues: SequenceCue[], time: number) {
  return (
    cues.find((cue) => time >= cue.start && time < cue.start + cue.duration) ??
    (time >= (cues.at(-1)?.start ?? Infinity) ? cues.at(-1) : cues[0])
  );
}
const DEXTERITY_STUDIES: { id: DexterityStudy; label: string }[] = [
  { id: "finger_ripple", label: "Finger ripple" },
  { id: "finger_touches", label: "Fingertip touches" },
  { id: "arm_wave", label: "Traveling wave" },
  { id: "coin_roll", label: "Coin roll" },
];
function dexterityCaption(skill: DexterityStudy, hand: Hand, reverse: boolean) {
  if (skill === "finger_ripple")
    return reverse
      ? `Reverse the finger ripple on your ${hand} hand.`
      : `Make a wave from pinky to thumb on your ${hand} hand.`;
  if (skill === "finger_touches")
    return `Touch your ${hand} thumb to each fingertip, ${reverse ? "pinky first" : "index first"}.`;
  if (skill === "arm_wave") {
    const start = reverse ? (hand === "left" ? "right" : "left") : hand;
    return `Send a wave from your ${start} fingertips to your ${start === "left" ? "right" : "left"} fingertips.`;
  }
  return `Roll a coin across your ${hand} knuckles${reverse ? " in reverse" : ""}.`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function CurvePlot({ curve }: { curve: Curve }) {
  const values = Array.from({ length: 81 }, (_, i) =>
    sampleCurve(curve, i / 80),
  );
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    range = max - min || 1;
  return (
    <svg
      className="motion-curve"
      viewBox="0 0 280 68"
      role="img"
      aria-label="Selected motion curve"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <line
          key={i}
          x1={10 + 65 * i}
          x2={10 + 65 * i}
          y1="8"
          y2="60"
          stroke="#333747"
          strokeDasharray="2 4"
        />
      ))}
      <polyline
        fill="none"
        stroke="#a78bfa"
        strokeWidth="2"
        points={values
          .map(
            (value, i) =>
              `${10 + (i / 80) * 260},${58 - ((value - min) / range) * 46}`,
          )
          .join(" ")}
      />
    </svg>
  );
}
export default function App() {
  const [startsWithGangnam] = useState(() => isGangnamExample());
  const [initialSequence] = useState(() => startsWithGangnam
    ? { program: createGangnam(), cues: [] as SequenceCue[] }
    : createDexteritySequence());
  const [character, setCharacter] = useState<CharacterLook>(() => initialCharacter());
  const [program, setProgram] = useState<MotionProgram>(
    initialSequence.program,
  );
  const timeline = useMemo(() => validateRigProgram(program), [program]);
  const performedHand = useMemo(() => currentMotionHand(program), [program]);
  const transport = useRef<Transport>({
    time: 0,
    playing: true,
    loop: startsWithGangnam,
    duration: timeline.duration,
  });
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(true),
    [loop, setLoop] = useState(startsWithGangnam);
  const [instruction, setInstruction] = useState(""),
    [caption, setCaption] = useState(startsWithGangnam ? "Dance Gangnam Style." : initialSequence.cues[0].instruction);
  const [origin, setOrigin] = useState(startsWithGangnam ? "Example · Gangnam Style" : "Example · Hand sequence"),
    [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const [selected, setSelected] = useState(initialSequence.program.root.id),
    [skeleton, setSkeleton] = useState(false);
  const [focus, setFocus] = useState<"body" | "left_hand" | "right_hand">(
    startsWithGangnam ? "body" : "left_hand",
  );
  const [dexterity, setDexterity] = useState<DexterityStudy | null>(null),
    [hand, setHand] = useState<Hand>("left"),
    [reverse, setReverse] = useState(false);
  const [sequenceCues, setSequenceCues] = useState<SequenceCue[]>(
      initialSequence.cues,
    ),
    [sequenceProgress, setSequenceProgress] = useState("");
  const [joint, setJoint] = useState("left_index_1"),
    [axis, setAxis] = useState<Axis>("z");
  const [json, setJson] = useState<string | null>(null),
    [jsonError, setJsonError] = useState("");
  const [recording, setRecording] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null),
    abort = useRef<AbortController | null>(null);
  const recorder = useRef<MediaRecorder | null>(null),
    recordFrame = useRef(0),
    recordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCue = sequenceCueAt(sequenceCues, time);
  const displayedCaption = activeCue
    ? activeCue.instruction || activeCue.label
    : caption;
  const captionRef = useRef(caption);
  captionRef.current = displayedCaption;
  const originRef = useRef(origin);
  originRef.current = origin;
  const sequenceCuesRef = useRef(sequenceCues);
  sequenceCuesRef.current = sequenceCues;
  const programRef = useRef(program);
  programRef.current = program;
  const selectedNode = findNode(program.root, selected);
  const [captureMode, setCaptureMode] = useState(false);
  const [cameraReset, setCameraReset] = useState(0);
  const [frozen, setFrozen] = useState<FrozenRotation[]>([]);
  const [undo, setUndo] = useState<
    {
      program: MotionProgram;
      frozen: FrozenRotation[];
      caption: string;
      cues: SequenceCue[];
      focus: "body" | "left_hand" | "right_hand";
      selected: string;
      joint: string;
      axis: Axis;
      hand: Hand;
      reverse: boolean;
      dexterity: DexterityStudy | null;
      character: CharacterLook;
    }[]
  >([]);
  const selectedTargets = useMemo(
    () =>
      selectedNode &&
      (selectedNode.id !== program.root.id ||
        branchTargets(selectedNode).length <= 3)
        ? branchTargets(selectedNode).filter((target) =>
            Object.hasOwn(JOINTS, target),
          )
        : [],
    [selectedNode, program.root.id],
  );
  const selectionFreezes = frozen.filter((item) =>
    item.targets.some((target) => selectedTargets.includes(target)),
  );
  const selectedFreeze = selectionFreezes[0];
  const blocked = selectedTargets.length
    ? editingBlockReason(program, selectedTargets)
    : null;
  const magnitude =
    selectedNode?.kind === "curve" ? rotationMagnitude(selectedNode) : null;
  const selectionLabel =
    selectedTargets.length === 1
      ? JOINT_LABEL(selectedTargets[0])
      : selectedTargets.length === 3 &&
          selectedTargets.every(
            (target) =>
              target.replace(/_[123]$/, "") ===
              selectedTargets[0].replace(/_[123]$/, ""),
          )
        ? JOINT_LABEL(selectedTargets[0].replace(/_[123]$/, "")) + " finger"
        : selectedNode
          ? shortNodeLabel(selectedNode)
          : "";
  const selectionPath = selectedNode
    ? nodePath(program.root, selected).slice(-3).map(shortNodeLabel).join(" → ")
    : "";
  const sliderStart = useRef<MotionProgram | null>(null);
  const curlReferences = useRef(new Map<string, CurveNode>());
  useEffect(() => {
    if (selectedNode?.kind === "curve" && magnitude && magnitude.value > 0)
      curlReferences.current.set(selectedNode.id, selectedNode);
  }, [selectedNode, magnitude?.value]);
  const selectionRef = useRef({ label: "", path: "", value: "" });
  selectionRef.current = {
    label: selectedTargets.length ? selectionLabel : "",
    path: selectionPath,
    value: selectedFreeze
      ? "Paused"
      : magnitude
        ? `${Math.round(magnitude.value)}° ${magnitude.label.toLowerCase()}`
        : "",
  };
  const detail = findJointDetail(program, joint, axis);
  const angle =
    detail?.kind === "curve" && detail.curve.kind === "constant"
      ? detail.curve.value
      : 0;
  const accept = useCallback((next: MotionProgram, restart = false) => {
    const compiled = validateRigProgram(next);
    const fraction = transport.current.duration
      ? transport.current.time / transport.current.duration
      : 0;
    transport.current.duration = compiled.duration;
    transport.current.time = restart ? 0 : fraction * compiled.duration;
    setTime(transport.current.time);
    if (restart) {
      transport.current.playing = true;
      setPlaying(true);
    }
    programRef.current = next;
    setProgram(next);
    setError("");
    if (restart) {
      setFrozen([]);
      setUndo([]);
      curlReferences.current.clear();
      sliderStart.current = null;
    }
  }, []);
  const cancelInference = () => {
    abort.current?.abort();
    abort.current = null;
    setBusy(false);
    setSequenceProgress("");
  };
  function chooseCharacter(next: CharacterLook) {
    if (next !== character) {
      setReady(false);
      setCharacter(next);
    }
  }
  function startOver() {
    cancelInference();
    if (recorder.current?.state === "recording") recorder.current.stop();
    const neutral = createDance("idle", "still");
    accept({ ...neutral, title: "Your motion" }, true);
    transport.current.time = 0;
    transport.current.playing = false;
    transport.current.loop = false;
    setTime(0);
    setPlaying(false);
    setLoop(false);
    setInstruction("");
    setCaption("Stand still.");
    setOrigin("Your motion");
    setRaw("");
    setSequenceCues([]);
    setSelected(neutral.root.id);
    setFocus("body");
    setCameraReset((value) => value + 1);
    setJoint("left_index_1");
    setAxis("z");
    setHand("left");
    setReverse(false);
    setDexterity(null);
    setSkeleton(false);
    setJson(null);
    setJsonError("");
    setCaptureMode(false);
  }
  function resumeCurrentMotion() {
    if (transport.current.time >= transport.current.duration) {
      transport.current.time = 0;
      setTime(0);
    }
    transport.current.playing = true;
    setPlaying(true);
  }
  const clearSequence = () => {
    setSequenceCues([]);
    setCaption(displayedCaption);
  };
  const edit = (next: MotionProgram, keepSequence = false) => {
    cancelInference();
    accept(next);
    setOrigin("Edited motion");
    if (keepSequence)
      setSequenceCues((cues) =>
        cues.map((cue) => ({
          ...cue,
          start: (cue.start * program.bpm) / next.bpm,
          duration: (cue.duration * program.bpm) / next.bpm,
        })),
      );
    else clearSequence();
  };
  function rememberEdit() {
    const previous = {
      program: programRef.current,
      frozen,
      caption: displayedCaption,
      cues: sequenceCues,
      focus,
      selected,
      joint,
      axis,
      hand,
      reverse,
      dexterity,
      character,
    };
    setUndo((items) => [...items.slice(-19), previous]);
  }
  function selectNode(id: string) {
    sliderStart.current = null;
    setSelected(id);
    const node = findNode(programRef.current.root, id);
    if (!node) return;
    const targets = branchTargets(node).filter((target) =>
      Object.hasOwn(JOINTS, target),
    );
    if (targets.length && targets.every((target) => target.startsWith("left_")))
      setHand("left");
    if (
      targets.length &&
      targets.every((target) => target.startsWith("right_"))
    )
      setHand("right");
    if (node.kind === "curve") {
      setJoint(node.target);
      setAxis(node.axis);
    }
    if (
      targets.length &&
      targets.every((target) =>
        /_(index|thumb|middle|ring|pinky)_[123]$/.test(target),
      )
    ) {
      const side = targets[0].startsWith("left") ? "left" : "right";
      if (targets.every((target) => target.startsWith(side)))
        setFocus(`${side}_hand`);
      else setFocus("body");
    } else if (targets.length) setFocus("body");
  }
  function pauseSelection() {
    try {
      rememberEdit();
      if (selectedFreeze) {
        edit(
          selectionFreezes.reduce(
            (next, token) => restoreFrozen(next, token),
            programRef.current,
          ),
        );
        setFrozen((items) =>
          items.filter((item) => !selectionFreezes.includes(item)),
        );
        setCaption(`Resume the ${selectionLabel.toLowerCase()}.`);
      } else {
        let next = programRef.current;
        const tokens: FrozenRotation[] = [];
        for (const target of selectedTargets) {
          const result = freezeTargets(next, [target], transport.current.time);
          next = result.program;
          tokens.push(result.token);
        }
        edit(next);
        setFrozen((items) => [...items, ...tokens]);
        setCaption(
          `Keep going. Pause just the ${selectionLabel.toLowerCase()}.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not edit this motion.");
    }
  }
  function applyLanguageEdit(op: string, target: string, text: string) {
    const current = programRef.current;
    const targets = resolveEditTarget(
      target,
      currentMotionHand(current) ?? hand,
      selectedTargets,
    );
    const matching = frozen.filter((item) =>
      item.targets.some((joint) => targets.includes(joint)),
    );
    let next = current;
    if (op === "restore") {
      if (!matching.length)
        throw new Error(
          "That selection is not paused. Pause a finger or joint first.",
        );
      next = matching.reduce(
        (value, token) => restoreFrozen(value, token),
        current,
      );
      rememberEdit();
      setFrozen((items) => items.filter((item) => !matching.includes(item)));
    } else {
      const already = new Set(matching.flatMap((item) => item.targets));
      const remaining = targets.filter((joint) => !already.has(joint));
      if (!remaining.length) return;
      const tokens: FrozenRotation[] = [];
      for (const joint of remaining) {
        const result = freezeTargets(next, [joint], transport.current.time);
        next = result.program;
        tokens.push(result.token);
      }
      rememberEdit();
      setFrozen((items) => [...items, ...tokens]);
    }
    accept(next);
    setSequenceCues([]);
    setCaption(text);
    setOrigin("Your motion");
    // Select the smallest existing branch that represents the requested joints.
    const search = (
      node: import("./motion/types").MotionNode,
    ): import("./motion/types").MotionNode | undefined => {
      if (/^editing\.freeze\.\d+$/.test(node.id)) return undefined;
      if (node.kind !== "curve" && node.kind !== "contact") {
        for (const child of node.children) {
          const found = search(child);
          if (found) return found;
        }
      }
      const joints = branchTargets(node);
      if (
        !/^editing\.freeze\.\d+\.root$/.test(node.id) &&
        joints.length === targets.length &&
        targets.every((joint) => joints.includes(joint))
      )
        return node;
    };
    const node = search(current.root);
    if (node) selectNode(node.id);
    else if (
      targets.every((joint) => /_(thumb|index|middle|ring|pinky)_/.test(joint))
    )
      setFocus(targets[0].startsWith("left") ? "left_hand" : "right_hand");
  }
  function undoEdit() {
    const previous = undo.at(-1);
    if (!previous) return;
    cancelInference();
    accept(previous.program);
    setFrozen(previous.frozen);
    setCaption(previous.caption);
    setSequenceCues(previous.cues);
    setFocus(previous.focus);
    setSelected(previous.selected);
    setJoint(previous.joint);
    setAxis(previous.axis);
    setHand(previous.hand);
    setReverse(previous.reverse);
    setDexterity(previous.dexterity);
    chooseCharacter(previous.character);
    setUndo((items) => items.slice(0, -1));
    setOrigin("Edited motion");
    sliderStart.current = null;
  }
  function beginCurlEdit() {
    if (!sliderStart.current) {
      sliderStart.current = programRef.current;
      rememberEdit();
    }
  }
  function changeCurl(value: number) {
    try {
      beginCurlEdit();
      edit(
        withRotationMagnitude(
          sliderStart.current!,
          selected,
          value,
          curlReferences.current.get(selected),
        ),
      );
      setCaption(`${selectionLabel} · ${Math.round(value)} degrees.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change this joint.");
    }
  }
  useEffect(() => {
    if (!captureMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCaptureMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [captureMode]);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("dbg")) return;
    const host = window as unknown as { __motionStudio?: unknown };
    host.__motionStudio = {
      snapshot: () => ({
        program: programRef.current,
        selected,
        selectedTargets,
        focus,
        captureMode,
        time: transport.current.time,
        frozen,
        cues: sequenceCues,
        caption: displayedCaption,
        origin,
        playing: transport.current.playing,
        loop: transport.current.loop,
        character,
      }),
      seek: (value: number) => {
        transport.current.time = value;
        transport.current.playing = false;
        setPlaying(false);
        setTime(value);
      },
    };
    return () => {
      delete host.__motionStudio;
    };
  }, [
    selected,
    selectedTargets,
    focus,
    captureMode,
    frozen,
    sequenceCues,
    displayedCaption,
    origin,
    character,
  ]);
  const onTick = useCallback((t: number, p: boolean) => {
    setTime(t);
    setPlaying(p);
  }, []);
  const onReady = useCallback(() => setReady(true), []);
  const onCanvas = useCallback((element: HTMLCanvasElement) => {
    canvas.current = element;
  }, []);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (recorder.current?.state === "recording") recorder.current.stop();
      cancelAnimationFrame(recordFrame.current);
      if (recordTimer.current) clearTimeout(recordTimer.current);
    },
    [],
  );
  function applyMotionCommands(
    commands: string,
    text: string,
    source = "Your motion",
  ) {
    const playback = /^playback (pause|resume|restart)$/.exec(commands.trim());
    if (playback) {
      // Transport commands keep the current scene, edits, and sequence intact.
      // A global pause does not create or restore individual joint freezes.
      if (playback[1] === "pause") {
        transport.current.playing = false;
        setPlaying(false);
        setTime(transport.current.time);
      } else if (playback[1] === "restart") restart();
      else resumeCurrentMotion();
      setError("");
      setRaw(commands);
      return;
    }
    const motionEdit = /^(freeze|restore) (\S+)$/.exec(commands.trim());
    if (motionEdit) {
      applyLanguageEdit(motionEdit[1], motionEdit[2], text);
      resumeCurrentMotion();
      setRaw(commands);
      return;
    }
    const lines = commands
      .trim()
      .split("\n")
      .map((line) => line.trim());
    const previous = programRef.current;
    const switchingHand = lines.some((line) => line.startsWith("hand "));
    const reversing = lines.includes("reverse current");
    // The showcase is a complete sequence. A new skill starts a new scene;
    // ordinary dance scenes retain their footwork when a skill is applied.
    const newScene = lines.some((line) => /^(dance|skill|action) /.test(line));
    const editedTargets = lines
      .filter((line) => /^(joint|wiggle) /.test(line))
      .map((line) => line.split(" ")[1]);
    const released = frozen.filter(
      (token) =>
        newScene ||
        token.targets.some((target) => editedTargets.includes(target)),
    );
    const restored = released.reduce(
      (next, token) => restoreFrozen(next, token),
      programRef.current,
    );
    const next = applyCommands(restored, commands);
    if (!newScene) rememberEdit();
    accept(next, newScene);
    if (lines.includes("dance gangnam")) chooseCharacter("gangnam");
    if (next.dance?.style === "gangnam") {
      transport.current.loop = true;
      setLoop(true);
    }
    const actionLines = lines.filter((line) => line.startsWith("action "));
    if (actionLines.length) {
      // Arm modifiers do not turn a lone gait into a finite sequence.
      const cyclic =
        actionLines.length === 1 &&
        /^action (walk|run|walk_wave|run_wave) 1$/.test(actionLines[0]);
      transport.current.loop = cyclic;
      setLoop(cyclic);
    }
    if (reversing) {
      transport.current.time = 0;
      setTime(0);
    }
    resumeCurrentMotion();
    if (!newScene)
      setFrozen((items) =>
        items
          .filter((token) => !released.includes(token))
          .map((token) => {
            const overlay = findNode(next.root, token.id);
            const at = (token.time * previous.bpm) / next.bpm;
            return {
              ...token,
              targets: overlay ? branchTargets(overlay) : token.targets,
              time: reversing ? transport.current.duration - at : at,
            };
          }),
      );
    if (switchingHand || reversing) {
      curlReferences.current.clear();
      sliderStart.current = null;
    }
    setSequenceCues([]);
    setCaption(text);
    setRaw(commands);
    setOrigin(source);
    const skill = lines.find((line) => line.startsWith("skill "))?.split(" ");
    if (skill) {
      const [, name, side, direction] = skill;
      setDexterity(name as DexterityStudy);
      setHand(side as Hand);
      setReverse(direction === "reverse");
      setSelected(next.root.id);
      setJoint(`${side}_index_1`);
      setAxis("z");
      setFocus(
        name === "arm_wave"
          ? "body"
          : (`${side}_hand` as "left_hand" | "right_hand"),
      );
    } else if (lines.some((line) => /^(dance|action) /.test(line))) {
      setDexterity(null);
      setReverse(false);
      setSelected(next.root.id);
    }
    const detail = lines
      .find((line) => /^(joint|wiggle) /.test(line))
      ?.split(" ");
    if (detail) {
      const [, target, nextAxis] = detail;
      setJoint(target);
      if (target.startsWith("left_")) setHand("left");
      if (target.startsWith("right_")) setHand("right");
      setAxis(nextAxis as Axis);
      setSelected(findJointDetail(next, target, nextAxis as Axis)!.id);
      setFocus(
        /_(index|thumb|middle|ring|pinky)_/.test(target)
          ? target.startsWith("left")
            ? "left_hand"
            : "right_hand"
          : "body",
      );
    } else if (lines.some((line) => /^(dance|action|arms|wave|support) /.test(line)))
      setFocus("body");
    const wave = lines.find((line) => line.startsWith("wave "))?.split(" ");
    if (wave) {
      setHand(wave[1] as Hand);
      setJoint(`${wave[1]}_wrist`);
      setSelected("hello_wave");
      setDexterity(null);
    }
    if (switchingHand) {
      const side = currentMotionHand(next);
      if (side) {
        setHand(side);
        setFocus(focus === "body" ? "body" : `${side}_hand`);
      }
      const node = findNode(next.root, selected);
      if (node?.kind === "curve" && Object.hasOwn(JOINTS, node.target)) {
        setJoint(node.target);
        setAxis(node.axis);
      }
    }
    if (reversing) setReverse((value) => !value);
  }
  function modifyCurrent(commands: string, text: string) {
    cancelInference();
    try {
      applyMotionCommands(commands, text, "Edited motion");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not edit this motion.");
    }
  }
  async function direct() {
    if (!instruction.trim()) return;
    cancelInference();
    const controller = new AbortController();
    abort.current = controller;
    const text = instruction.trim();
    setBusy(true);
    setError("");
    try {
      const commands = await directMotion(text, controller.signal);
      if (controller.signal.aborted) return;
      applyMotionCommands(commands, text);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not direct motion.");
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        abort.current = null;
      }
    }
  }
  function study(style: DanceStyle) {
    cancelInference();
    const next = createDance(style, style === "robot" ? "robot" : "natural", style === "gangnam" ? 132 : program.bpm);
    accept(next, true);
    setSequenceCues([]);
    setCaption(
      style === "idle" ? "Stand still." : style === "gangnam" ? "Dance Gangnam Style." : `Dance ${style.replace("_", "-")}.`,
    );
    setOrigin(
      `Example · ${style === "idle" ? "Stand still" : style === "gangnam" ? "Gangnam Style" : style === "cha_cha" ? "Cha-cha" : style === "salsa" ? "Salsa" : "Robot"}`,
    );
    setRaw("");
    setSelected(next.root.id);
    setFocus("body");
    setDexterity(null);
    setReverse(false);
    if (style === "gangnam") {
      transport.current.loop = true;
      setLoop(true);
      chooseCharacter("gangnam");
    }
  }
  function dexterityStudy(
    skill: DexterityStudy,
    side = performedHand ?? hand,
    backwards = reverse,
  ) {
    cancelInference();
    try {
      const next = createDexterity(skill, side, backwards, program.bpm);
      accept(next, true);
      transport.current.loop = true;
      setLoop(true);
      setDexterity(skill);
      setHand(side);
      setReverse(backwards);
      setSequenceCues([]);
      setCaption(dexterityCaption(skill, side, backwards));
      setOrigin(
        `Example · ${DEXTERITY_STUDIES.find(({ id }) => id === skill)!.label}`,
      );
      setRaw("");
      setSelected(next.root.id);
      setJoint(`${side}_index_1`);
      setAxis("z");
      setFocus(skill === "arm_wave" ? "body" : `${side}_hand`);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load this motion study.",
      );
    }
  }
  function playSequence(side = performedHand ?? hand, commands?: string[]) {
    const result = createDexteritySequence(commands, side);
    accept(result.program, true);
    transport.current.loop = false;
    setLoop(false);
    setSequenceCues(result.cues);
    setDexterity(null);
    setHand(side);
    setReverse(false);
    setCaption(result.cues[0].instruction);
    setSelected(result.program.root.id);
    setJoint(`${side}_index_1`);
    setAxis("z");
    setFocus(`${side}_hand`);
    setOrigin(commands ? "Your motion" : "Example · Hand sequence");
    setRaw(commands?.join("\n") ?? "");
  }
  function previewSequence(side = performedHand ?? hand) {
    cancelInference();
    try {
      playSequence(side);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load the motion sequence.",
      );
    }
  }
  async function directSequence() {
    cancelInference();
    const controller = new AbortController();
    abort.current = controller;
    const side = performedHand ?? hand,
      directions = getDexteritySequenceInstructions(side),
      commands: string[] = [];
    setBusy(true);
    setError("");
    try {
      for (const [index, direction] of directions.entries()) {
        setSequenceProgress(
          `${index + 1} / ${directions.length} · ${direction}`,
        );
        const output = await directMotion(direction, controller.signal);
        if (controller.signal.aborted) return;
        commands.push(output);
      }
      playSequence(side, commands);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Could not direct the motion sequence.",
        );
    } finally {
      if (abort.current === controller) {
        setBusy(false);
        setSequenceProgress("");
        abort.current = null;
      }
    }
  }
  function togglePlay() {
    const state = transport.current;
    if (!state.playing && state.time >= state.duration) {
      state.time = 0;
      setTime(0);
    }
    state.playing = !state.playing;
    setPlaying(state.playing);
  }
  function restart() {
    seek(0);
    transport.current.playing = true;
    setPlaying(true);
  }
  function seek(value: number) {
    transport.current.time = value;
    setTime(value);
  }
  function startRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    if (!canvas.current || typeof MediaRecorder === "undefined") {
      setError("This browser does not support video recording.");
      return;
    }
    const output = document.createElement("canvas");
    output.width = 1080;
    output.height = 1080;
    const ctx = output.getContext("2d")!;
    const draw = () => {
      if (rec.state !== "recording") return;
      const source = canvas.current;
      if (!source?.isConnected) {
        recordFrame.current = requestAnimationFrame(draw);
        return;
      }
      const currentCue = sequenceCueAt(
        sequenceCuesRef.current,
        transport.current.time,
      );
      drawRecordingFrame(ctx, source, {
        caption: currentCue
          ? currentCue.instruction || currentCue.label
          : captionRef.current,
        selectionLabel: selectionRef.current.label,
        selectionPath: selectionRef.current.path,
        selectionValue: selectionRef.current.value,
        origin: originRef.current,
      });
      // Request the finished composite explicitly. Depending on a later canvas
      // paint can leave a short recording with only its container header.
      captureTrack.requestFrame?.();
      recordFrame.current = requestAnimationFrame(draw);
    };
    const mimeType = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/mp4",
      "video/webm",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      cancelAnimationFrame(recordFrame.current);
      setError("No supported video format.");
      return;
    }
    const stream = output.captureStream(30);
    const captureTrack =
      stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const rec = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    recorder.current = rec;
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    rec.onstop = () => {
      cancelAnimationFrame(recordFrame.current);
      stream.getTracks().forEach((track) => track.stop());
      if (recordTimer.current) clearTimeout(recordTimer.current);
      recorder.current = null;
      setRecording(false);
      download(
        new Blob(chunks, { type: mimeType }),
        `avatar-director.${mimeType.includes("mp4") ? "mp4" : "webm"}`,
      );
    };
    if (transport.current.time >= transport.current.duration) seek(0);
    transport.current.playing = true;
    setPlaying(true);
    rec.start();
    // Start drawing after capture is armed. Waiting for onstart can deadlock:
    // some encoders emit that event only once they receive their first frame.
    draw();
    setRecording(true);
    if (sequenceCues.length) {
      transport.current.loop = false;
      setLoop(false);
    }
    recordTimer.current = setTimeout(
      () => {
        if (rec.state === "recording") rec.stop();
      },
      sequenceCues.length
        ? Math.min(30_000, (timeline.duration - transport.current.time) * 1000)
        : 30_000,
    );
  }
  function setJointAngle(value: number) {
    const next = jointOffset(program, joint, axis, value);
    edit(next);
    setSelected(findJointDetail(next, joint, axis)!.id);
  }
  function oneFinger() {
    const next = jointOffset(
      createDance("idle"),
      "left_index_1",
      "z",
      65,
      true,
    );
    cancelInference();
    accept(next, true);
    setSequenceCues([]);
    setFocus("left_hand");
    setSelected("detail.left_index_1.z");
    setJoint("left_index_1");
    setAxis("z");
    setDexterity(null);
    setHand("left");
    setReverse(false);
    transport.current.loop = true;
    setLoop(true);
    setCaption("Wiggle only the left index finger 65 degrees.");
    setOrigin("Example · One finger");
    setRaw("");
  }
  return (
    <>
      {!captureMode && <SiteHeader />}
      <main className={`motion-studio ${captureMode ? "capture-mode" : ""}`}>
        <div className="motion-demo-layout">
          <section className="motion-stage" aria-label="Avatar preview">
            <MotionStage
              character={character}
              timeline={timeline}
              transport={transport}
              skeleton={skeleton}
              focus={focus}
              cameraReset={cameraReset}
              selectedTargets={selectedTargets}
              onTick={onTick}
              onReady={onReady}
              onCanvas={onCanvas}
            />
            {!ready && (
              <div className="motion-loading">
                <Loader2 className="motion-spin" />
                Loading the character…
              </div>
            )}
            <div className="motion-stage-top">
              <span className="motion-stage-label">
                <span className="motion-live-dot" />
                {origin}
              </span>
              <div>
                <button
                  aria-label={
                    captureMode ? "Exit recording view" : "Recording view"
                  }
                  title={
                    captureMode ? "Exit recording view (Esc)" : "Recording view"
                  }
                  onClick={() => setCaptureMode(!captureMode)}
                >
                  {captureMode ? (
                    <Minimize2 size={17} />
                  ) : (
                    <Maximize2 size={17} />
                  )}
                </button>
                <button
                  aria-label={
                    focus === "body" ? "Hand camera" : "Full body camera"
                  }
                  title={focus === "body" ? "Hand close-up" : "Full body"}
                  onClick={() =>
                    setFocus(focus === "body" ? `${hand}_hand` : "body")
                  }
                >
                  <Focus size={17} />
                </button>
                <button
                  aria-label={
                    recording ? "Stop recording" : "Record current motion"
                  }
                  title={
                    recording
                      ? "Stop recording"
                      : "Record this motion from the current playhead (up to 30 seconds)"
                  }
                  onClick={startRecording}
                  className={recording ? "recording" : ""}
                >
                  <Video size={17} />
                  {recording && "REC"}
                </button>
              </div>
            </div>
            {selectedTargets.length > 0 && (
              <div
                className="motion-selection-badge"
                aria-label="Selected motion"
              >
                <span>{selectionLabel}</span>
                {(selectedFreeze || magnitude) && (
                  <strong>
                    {selectedFreeze
                      ? "Paused"
                      : `${Math.round(magnitude!.value)}°`}
                  </strong>
                )}
              </div>
            )}
            <div className="motion-caption">
              <span>
                {activeCue ? activeCue.label.toUpperCase() : "DIRECTION"}
              </span>
              <p>{displayedCaption}</p>
            </div>
            <div className="motion-transport">
              <div className="motion-transport-controls">
                <button
                  aria-label={
                    playing ? "Pause current motion" : "Play current motion"
                  }
                  title={
                    playing ? "Pause current motion" : "Play current motion"
                  }
                  onClick={togglePlay}
                >
                  {playing ? (
                    <Pause size={18} fill="currentColor" />
                  ) : (
                    <Play size={18} fill="currentColor" />
                  )}
                </button>
                <button
                  aria-label="Replay current motion"
                  title="Replay current motion from the beginning"
                  onClick={restart}
                >
                  <RotateCcw size={16} />
                </button>
                <span>
                  {time.toFixed(2)} <i>/ {timeline.duration.toFixed(2)}s</i>
                </span>
                <label className="motion-loop">
                  <input
                    type="checkbox"
                    checked={loop}
                    onChange={(event) => {
                      setLoop(event.target.checked);
                      transport.current.loop = event.target.checked;
                    }}
                  />{" "}
                  Loop
                </label>
              </div>
              <input
                className="motion-scrubber"
                aria-label="Timeline"
                type="range"
                min="0"
                max={timeline.duration}
                step="0.001"
                value={time}
                onChange={(event) => seek(Number(event.target.value))}
              />
            </div>
          </section>

          <section
            className="motion-direction-panel"
            aria-label="Direct the avatar"
          >
            <div className="motion-heading">
              <span className="motion-product-label">
                <Sparkles size={16} /> Avatar Director
              </span>
              <h1>Tell the character what to do.</h1>
            </div>
            <form
              className="motion-prompt"
              onSubmit={(event) => {
                event.preventDefault();
                void direct();
              }}
            >
              <div className="motion-session">
                <span>Editing current motion</span>
                <button type="button" onClick={startOver}>
                  <RotateCcw size={13} /> Start over
                </button>
              </div>
              <textarea
                aria-label="Direction"
                placeholder={program.dance?.style === "gangnam" ? "Now on one foot" : "Wiggle only the left index finger 65 degrees"}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                maxLength={400}
                rows={1}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void direct();
                  }
                }}
              />
              <button
                className="motion-primary"
                disabled={busy || !instruction.trim()}
              >
                {busy ? (
                  <Loader2 size={17} className="motion-spin" />
                ) : (
                  <Play size={17} fill="currentColor" />
                )}
                {busy ? "Applying…" : "Apply direction"}
              </button>
            </form>
            {sequenceProgress && (
              <div
                className="motion-sequence-progress"
                role="status"
                aria-label="Sequence progress"
              >
                <Loader2 size={14} className="motion-spin" />
                <span>{sequenceProgress}</span>
                <button onClick={cancelInference}>Cancel</button>
              </div>
            )}
            {error && (
              <div className="motion-error" role="alert">
                {error}
                <button aria-label="Dismiss error" onClick={() => setError("")}>
                  <X size={15} />
                </button>
              </div>
            )}

            <div className="motion-quick-examples" aria-label="Example motions">
              <p className="motion-examples-label">Load an example</p>
              <div className="motion-example-buttons">
                <button
                  onClick={() => study("gangnam")}
                  aria-pressed={program.dance?.style === "gangnam"}
                >
                  Gangnam Style
                </button>
                <button
                  onClick={() => dexterityStudy("finger_ripple")}
                  aria-pressed={dexterity === "finger_ripple"}
                >
                  Finger ripple
                </button>
                <button onClick={oneFinger}>One finger</button>
                <button
                  aria-pressed={dexterity === "finger_touches"}
                  onClick={() => dexterityStudy("finger_touches")}
                >
                  Fingertip touches
                </button>
                <button
                  aria-pressed={dexterity === "coin_roll"}
                  onClick={() => dexterityStudy("coin_roll")}
                >
                  Coin roll
                </button>
              </div>
            </div>
            <MotionTree
              program={program}
              timeline={timeline}
              time={time}
              playing={playing}
              selected={selected}
              onSelect={selectNode}
            >
              {selectedTargets.length > 0 && (
                <div className="live-joint-controls">
                  <div className="live-joint-title">
                    <span>{selectionLabel}</span>
                    <button
                      onClick={undoEdit}
                      disabled={!undo.length}
                      aria-label="Undo edit"
                    >
                      <Undo2 size={14} /> Undo
                    </button>
                  </div>
                  {magnitude && !blocked && (
                    <label className="live-curl-control">
                      <span>{magnitude.label}</span>
                      <output>{Math.round(magnitude.value)}°</output>
                      <input
                        aria-label="Curl amount"
                        type="range"
                        min="0"
                        max={magnitude.max}
                        step="1"
                        value={magnitude.value}
                        disabled={!!selectedFreeze}
                        onPointerDown={beginCurlEdit}
                        onPointerUp={() => {
                          sliderStart.current = null;
                        }}
                        onKeyUp={() => {
                          sliderStart.current = null;
                        }}
                        onBlur={() => {
                          sliderStart.current = null;
                        }}
                        onChange={(event) =>
                          changeCurl(Number(event.target.value))
                        }
                      />
                    </label>
                  )}
                  {blocked ? (
                    <p className="live-edit-hint">
                      {blocked}{" "}
                      <button onClick={() => dexterityStudy("finger_ripple")}>
                        Try a finger ripple
                      </button>
                    </p>
                  ) : (
                    <button className="live-freeze" onClick={pauseSelection}>
                      {selectedFreeze ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                      {selectedFreeze
                        ? "Restore motion"
                        : selectedTargets.length === 1
                          ? "Pause joint"
                          : selectedTargets.length === 3
                            ? "Pause finger"
                            : "Pause selection"}
                    </button>
                  )}
                </div>
              )}
            </MotionTree>
            <details className="motion-disclosure motion-more">
              <summary>More motions</summary>
              <div className="motion-example-buttons">
                <button
                  onClick={() => previewSequence()}
                  aria-pressed={sequenceCues.length > 0}
                >
                  Load hand demo
                </button>
                <button onClick={() => study("salsa")}>Salsa</button>
                <button onClick={() => study("cha_cha")}>Cha-cha</button>
                <button onClick={() => study("robot")}>Robot</button>
                {DEXTERITY_STUDIES.filter(({ id }) => id === "arm_wave").map(
                  ({ id, label }) => (
                    <button
                      key={id}
                      aria-pressed={dexterity === id}
                      onClick={() => dexterityStudy(id)}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
              <div className="motion-dexterity-options">
                <label>
                  Hand
                  <select
                    aria-label="Dexterity hand"
                    value={performedHand ?? hand}
                    disabled={!performedHand}
                    onChange={(event) => {
                      const side = event.target.value as Hand;
                      modifyCurrent(`hand ${side}`, `Use your ${side} hand.`);
                    }}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </label>
                <button
                  aria-label="Reverse dexterity motion"
                  aria-pressed={reverse}
                  onClick={() => {
                    modifyCurrent(
                      "reverse current",
                      "Reverse the current motion.",
                    );
                  }}
                >
                  <RotateCcw size={14} /> Reverse
                </button>
              </div>
              <button
                className="motion-sequence-direct"
                disabled={busy}
                onClick={() => void directSequence()}
              >
                <Sparkles size={15} /> Recreate demo from prompts
              </button>
            </details>
            <details className="motion-disclosure motion-editor">
              <summary>
                <SlidersHorizontal size={15} /> Edit motion
              </summary>
              <aside className="motion-inspector">
                <div className="motion-panel-title">
                  <h2>Advanced controls</h2>
                  <button
                    aria-label="Edit motion JSON"
                    title="Edit / import motion JSON"
                    onClick={() => {
                      setJson(JSON.stringify(program, null, 2));
                      setJsonError("");
                    }}
                  >
                    <Code2 size={17} />
                  </button>
                  <button
                    aria-label="Export motion JSON"
                    title="Export editable motion"
                    onClick={() =>
                      download(
                        new Blob([JSON.stringify(program, null, 2)], {
                          type: "application/json",
                        }),
                        "avatar-motion.json",
                      )
                    }
                  >
                    <Download size={16} />
                  </button>
                  <button
                    aria-label="Toggle skeleton"
                    title="Skeleton"
                    aria-pressed={skeleton}
                    onClick={() => setSkeleton(!skeleton)}
                  >
                    <ScanLine size={17} />
                  </button>
                </div>
                <div className="motion-global-controls">
                  <label>
                    Character
                    <select
                      aria-label="Character"
                      value={character}
                      onChange={(event) => chooseCharacter(event.target.value as CharacterLook)}
                    >
                      <option value="jade">Classic avatar</option>
                      <option value="gangnam">Blue tux</option>
                      {character === "mixamo" && <option value="mixamo">Your Mixamo character</option>}
                    </select>
                  </label>
                  <label>
                    Tempo{" "}
                    <span>
                      {program.bpm} <small>BPM</small>
                    </span>
                    <input
                      aria-label="Tempo"
                      type="range"
                      min="30"
                      max="240"
                      step="1"
                      value={program.bpm}
                      onChange={(event) =>
                        edit(
                          changeTempo(program, Number(event.target.value)),
                          true,
                        )
                      }
                    />
                  </label>
                  <label>
                    Arm choreography
                    <select
                      aria-label="Arm choreography"
                      disabled={!findNode(program.root, "arms")}
                      value={
                        program.root.kind !== "curve"
                          ? (findNode(program.root, "arms")?.label.split(
                              " · ",
                            )[1] ?? "natural")
                          : "natural"
                      }
                      onChange={(event) =>
                        edit(
                          replaceArms(program, event.target.value as ArmStyle),
                        )
                      }
                    >
                      <option value="natural">Natural</option>
                      <option value="robot">Robot</option>
                      <option value="wave">Right-hand wave</option>
                      <option value="still">Still</option>
                    </select>
                  </label>
                </div>
                <div className="motion-joint-editor">
                  <div className="motion-panel-title">
                    <SlidersHorizontal size={15} />
                    <h2>Joint detail</h2>
                  </div>
                  <div className="motion-joint-select">
                    <select
                      aria-label="Joint"
                      value={joint}
                      onChange={(event) => {
                        setJoint(event.target.value);
                        if (event.target.value.startsWith("left_"))
                          setHand("left");
                        if (event.target.value.startsWith("right_"))
                          setHand("right");
                        setFocus(
                          /_(index|thumb|middle|ring|pinky)_/.test(
                            event.target.value,
                          )
                            ? event.target.value.startsWith("left")
                              ? "left_hand"
                              : "right_hand"
                            : "body",
                        );
                      }}
                    >
                      {Object.keys(JOINTS).map((id) => (
                        <option key={id} value={id}>
                          {JOINT_LABEL(id)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Joint axis"
                      value={axis}
                      onChange={(event) => setAxis(event.target.value as Axis)}
                    >
                      <option>x</option>
                      <option>y</option>
                      <option>z</option>
                    </select>
                  </div>
                  <label className="motion-angle">
                    <span>Rotation offset</span>
                    <output>{angle}°</output>
                    <input
                      aria-label="Joint angle"
                      type="range"
                      min="-180"
                      max="180"
                      step="1"
                      value={angle}
                      onChange={(event) =>
                        setJointAngle(Number(event.target.value))
                      }
                    />
                  </label>
                  <p>Local axes for fingers. Body axes for larger joints.</p>
                </div>
                {selectedNode?.kind === "curve" && (
                  <div className="motion-leaf-editor">
                    <div className="motion-leaf-heading">
                      <span>{selectedNode.curve.kind.toUpperCase()} CURVE</span>
                      <code>
                        {selectedNode.target}.{selectedNode.axis}
                      </code>
                    </div>
                    <CurvePlot curve={selectedNode.curve} />
                    <CurveEditor
                      node={selectedNode}
                      onChange={(curve) =>
                        edit({
                          ...program,
                          root: updateNode(program.root, selected, (node) =>
                            node.kind === "curve" ? { ...node, curve } : node,
                          ),
                        })
                      }
                    />
                    <button
                      onClick={() => {
                        setJson(JSON.stringify(program, null, 2));
                        setJsonError("");
                      }}
                    >
                      Edit keyframes <ArrowUpRight size={12} />
                    </button>
                    <button
                      onClick={() =>
                        edit({
                          ...program,
                          root: updateNode(program.root, selected, (node) =>
                            node.kind === "curve"
                              ? {
                                  ...node,
                                  curve: { kind: "constant", value: 0 },
                                }
                              : node,
                          ),
                        })
                      }
                    >
                      Zero this curve
                    </button>
                  </div>
                )}
                {selectedNode?.kind === "contact" && (
                  <div
                    className="motion-leaf-editor motion-contact-editor"
                    aria-label="Contact detail"
                  >
                    <div className="motion-leaf-heading">
                      <span>
                        {selectedNode.mode === "fingertips"
                          ? "FINGERTIP CONTACT"
                          : "PROP TRANSFER"}
                      </span>
                      <code>{selectedNode.duration.toFixed(2)}s</code>
                    </div>
                    <p>
                      {selectedNode.mode === "fingertips" ? (
                        <>
                          {JOINT_LABEL(selectedNode.effector)} →{" "}
                          {JOINT_LABEL(selectedNode.target)}
                        </>
                      ) : (
                        <>
                          {JOINT_LABEL(selectedNode.prop)} ·{" "}
                          {JOINT_LABEL(selectedNode.from)} →{" "}
                          {JOINT_LABEL(selectedNode.to)}
                        </>
                      )}
                    </p>
                    <CurvePlot
                      curve={
                        selectedNode.mode === "fingertips"
                          ? selectedNode.weight
                          : selectedNode.progress
                      }
                    />
                    <p className="motion-contact-hint">
                      {selectedNode.mode === "fingertips"
                        ? "The curve controls how closely the fingertips meet."
                        : "The curve controls the transfer between finger contacts."}{" "}
                      Edit its timing and curve in Motion JSON.
                    </p>
                    <button
                      onClick={() => {
                        setJson(JSON.stringify(program, null, 2));
                        setJsonError("");
                      }}
                    >
                      Edit contact in Motion JSON <ArrowUpRight size={12} />
                    </button>
                  </div>
                )}
              </aside>{" "}
              {sequenceCues.length > 0 && (
                <nav
                  className="motion-sequence-chapters"
                  aria-label="Sequence chapters"
                >
                  {sequenceCues.map((cue) => (
                    <button
                      key={cue.id}
                      aria-current={
                        activeCue?.id === cue.id ? "step" : undefined
                      }
                      onClick={() => seek(cue.start)}
                    >
                      <span>{cue.label}</span>
                      <small>{cue.start.toFixed(1)}s</small>
                    </button>
                  ))}
                </nav>
              )}
              <footer className="motion-footer">
                <span>
                  <Check size={13} /> {timeline.tracks.length} editable curves
                  {timeline.contacts?.length
                    ? ` · ${timeline.contacts.length} contacts`
                    : ""}{" "}
                  · foot targets + inverse kinematics
                </span>
                <span>
                  PAW interprets language. The motion engine moves the rig.{" "}
                  <a
                    href={`${import.meta.env.BASE_URL}assets/character.glb`}
                    download
                  >
                    Character ↗
                  </a>
                </span>
              </footer>
              {raw && (
                <details className="motion-commands">
                  <summary>Last PAW command program</summary>
                  <pre>{raw}</pre>
                </details>
              )}
            </details>
            <div className="motion-links">
              <a
                href="https://github.com/programasweights/avatar/blob/main/MOTION.md"
                target="_blank"
                rel="noreferrer"
              >
                How is it built? <ArrowUpRight size={14} />
              </a>
              <a
                href="https://github.com/programasweights/avatar"
                target="_blank"
                rel="noreferrer"
              >
                Source code <ArrowUpRight size={14} />
              </a>
            </div>
          </section>
        </div>
        {json !== null && (
          <div className="motion-modal-backdrop">
            <section
              className="motion-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Motion program JSON"
            >
              <div className="motion-panel-title">
                <h2>Editable motion program</h2>
                <button
                  aria-label="Close JSON editor"
                  onClick={() => setJson(null)}
                >
                  <X size={20} />
                </button>
              </div>
              <p>
                Sequence, parallel, repeat → rotation / position → constant,
                sine or keyframe curves. Times in seconds; rotations in degrees.
              </p>
              <textarea
                aria-label="Motion JSON"
                value={json}
                onChange={(event) => setJson(event.target.value)}
                spellCheck={false}
              />
              {jsonError && (
                <p role="alert" className="motion-json-error">
                  {jsonError}
                </p>
              )}
              <div className="motion-modal-actions">
                <button onClick={() => setJson(null)}>Cancel</button>
                <button
                  className="motion-primary"
                  onClick={() => {
                    try {
                      const next = JSON.parse(json) as MotionProgram;
                      validateRigProgram(next);
                      cancelInference();
                      accept(next);
                      setFrozen([]);
                      setUndo([]);
                      curlReferences.current.clear();
                      sliderStart.current = null;
                      setSequenceCues([]);
                      setCaption(next.title);
                      setOrigin("Imported motion");
                      setDexterity(null);
                      setReverse(false);
                      const importedHand = currentMotionHand(next);
                      if (importedHand) setHand(importedHand);
                      setFocus(importedHand ? `${importedHand}_hand` : "body");
                      setCameraReset((value) => value + 1);
                      setJson(null);
                      setSelected(next.root.id);
                    } catch (e) {
                      setJsonError(
                        e instanceof Error ? e.message : "Invalid motion JSON.",
                      );
                    }
                  }}
                >
                  Apply program
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </>
  );
}
