// Capture the production sequence deterministically. No prerecorded motion is used.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MotionRig } from "../src/motion/rig";
import {
  compileMotion,
  sampleContacts,
  sampleTimeline,
} from "../src/motion/engine";
import { createDexteritySequence } from "../src/motion/dexteritySequence";
import { validateRigProgram } from "../src/motion/director";
import { motionHandFrame } from "../src/motion/MotionStage";
const W = 1080,
  H = 1080,
  SH = 842,
  TOP = 58;
const out = document.createElement("canvas");
out.width = W;
out.height = H;
document.body.append(out);
const ctx = out.getContext("2d")!;
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.setSize(W, SH);
renderer.setPixelRatio(1);
renderer.setClearColor("#101719");
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#101719");
scene.fog = new THREE.Fog("#101719", 6, 13);
scene.add(new THREE.HemisphereLight("#e7fff7", "#2c3c44", 1.1));
for (const [color, intensity, position] of [
  ["#ffffff", 3, [3, 6, 4]],
  ["#8bf6ce", 2, [-3, 3, 1]],
  ["#a1b9ff", 3, [0, 3, -4]],
] as const) {
  const light = new THREE.DirectionalLight(color, intensity);
  light.position.set(position[0], position[1], position[2]);
  scene.add(light);
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30),
  new THREE.MeshStandardMaterial({ color: "#101719", roughness: 1 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.018;
scene.add(floor);
const grid = new THREE.GridHelper(16, 64, "#344642", "#203231");
grid.position.y = -0.014;
scene.add(grid);
const hand = new THREE.PerspectiveCamera(30, W / SH, 0.01, 50);
const body = new THREE.PerspectiveCamera(30, 144 / 180, 0.01, 50);
body.position.set(2.1, 1.65, 3.8);
body.lookAt(0, 0.93, 0);
const model = await new GLTFLoader().loadAsync(
  `${import.meta.env.BASE_URL}assets/character.glb`,
);
scene.add(model.scene);
const rig = new MotionRig(model.scene, model.animations);
let sequence = createDexteritySequence(),
  timeline = compileMotion(sequence.program),
  side: "left" | "right" = "left";
let handView = true;
function initialize(
  input?: {
    program: import("../src/motion/types").MotionProgram;
    cues?: typeof sequence.cues;
  },
  handSide: "left" | "right" = "left",
) {
  sequence = input
    ? { program: input.program, cues: input.cues ?? [] }
    : createDexteritySequence(undefined, handSide);
  timeline = validateRigProgram(sequence.program);
  side = handSide;
  handView = timeline.tracks.some((track) =>
    /_(thumb|index|middle|ring|pinky)_/.test(track.target),
  );
  return { ...sequence, width: W, height: H, duration: timeline.duration };
}
function pose(time: number) {
  const t = THREE.MathUtils.clamp(time, 0, timeline.duration),
    values = sampleTimeline(timeline, t);
  rig.apply(values, sampleContacts(timeline, t), timeline.props);
  const frame = motionHandFrame(rig.joints, timeline, side, t);
  hand.position.copy(frame.position);
  hand.up.copy(frame.up);
  hand.lookAt(frame.target);
  return t;
}
function wrap(text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
function render(time: number, format: "jpeg" | "png" = "jpeg") {
  const t = pose(time),
    cue = sequence.cues.find((c) => t >= c.start && t < c.start + c.duration) ??
      sequence.cues.at(-1) ?? {
        id: "custom",
        instruction: sequence.program.title,
      };
  renderer.setViewport(0, 0, W, SH);
  renderer.setScissorTest(false);
  if (!handView) {
    body.aspect = W / SH;
    body.updateProjectionMatrix();
  }
  renderer.render(scene, handView ? hand : body);
  ctx.fillStyle = "#101719";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(renderer.domElement, 0, TOP);
  if (handView) {
    body.aspect = 144 / 180;
    body.updateProjectionMatrix();
    // Keep the full avatar visible without obscuring the approaching fingertips.
    const iw = 144,
      ih = 180,
      ix = 30,
      iy = 82;
    renderer.setViewport(0, 0, iw, ih);
    renderer.setScissor(0, 0, iw, ih);
    renderer.setScissorTest(true);
    renderer.render(scene, body);
    ctx.fillStyle = "#334a43";
    ctx.fillRect(ix - 2, iy - 2, iw + 4, ih + 4);
    ctx.drawImage(renderer.domElement, 0, SH - ih, iw, ih, ix, iy, iw, ih);
  }
  ctx.fillStyle = "#b3c9be";
  ctx.font = "500 16px sans-serif";
  ctx.fillText("AVATAR DIRECTOR", 36, 35);
  ctx.textAlign = "right";
  ctx.fillStyle = "#88b5a1";
  ctx.font = "500 14px sans-serif";
  ctx.fillText("EDITABLE MOTION SEQUENCE", W - 36, 35);
  ctx.textAlign = "left";
  // The turn is choreography between directions, not a fabricated PAW request.
  const instruction =
    cue.instruction ||
    sequence.cues.find((c) => c.id === "coin")?.instruction ||
    sequence.program.title;
  const cueIndex =
    cue.id === "turn"
      ? 3
      : ["ripple", "reverse", "touches", "coin"].indexOf(cue.id);
  ctx.fillStyle = "#a7f3d0";
  ctx.font = "500 14px sans-serif";
  ctx.fillText(
    cue.id === "custom"
      ? "MOTION STUDY"
      : cue.id === "turn"
        ? "NEXT DIRECTION"
        : "YOUR DIRECTION",
    36,
    927,
  );
  ctx.fillStyle = "#f2f6f4";
  ctx.font = "500 37px sans-serif";
  wrap(instruction, W - 72).forEach((line, i) =>
    ctx.fillText(line, 36, 973 + i * 45),
  );
  const labels = ["RIPPLE", "REVERSE", "TOUCH", "COIN"];
  for (let i = 0; sequence.cues.length && i < 4; i++) {
    const x = 36 + (i * (W - 72)) / 4;
    ctx.fillStyle = i === cueIndex ? "#b8f5d9" : "#607d70";
    ctx.font = "500 11px sans-serif";
    ctx.fillText(labels[i], x, 1053);
    ctx.fillStyle = i <= cueIndex ? "#a7f3d0" : "#2b4139";
    ctx.fillRect(x, 1065, (W - 96) / 4, 3);
  }
  return out
    .toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.96)
    .split(",")[1];
}
(window as any).__sequence = {
  initialize,
  render,
  inspect: (time: number) => {
    pose(time);
    return {
      joints: rig.snapshot(),
      props: rig.props.snapshot(),
      camera: {
        position: hand.position.toArray(),
        up: hand.up.toArray(),
        quaternion: hand.quaternion.toArray(),
      },
    };
  },
  rig,
};
