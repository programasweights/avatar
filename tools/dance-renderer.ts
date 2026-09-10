// Render the same editable curves and character used by the live studio.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MotionRig } from "../src/motion/rig";
import { compileMotion, sampleContacts, sampleTimeline } from "../src/motion/engine";
import { createGangnam } from "../src/motion/gangnam";
import { createGangnamLaunch } from "./gangnam-launch";
import { validateRigProgram } from "../src/motion/director";
import type { MotionProgram } from "../src/motion/types";

const W = 1080, H = 1080;
const out = document.createElement("canvas");
out.width = W;
out.height = H;
document.body.append(out);
const ctx = out.getContext("2d")!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#101119");
scene.fog = new THREE.Fog("#101119", 7, 16);
scene.add(new THREE.HemisphereLight("#fff9f2", "#343442", 1.35));
for (const [color, intensity, position] of [
  ["#fff6ea", 2.5, [3, 6, 4]],
  ["#e7e9ff", 1.35, [-3, 3, 1]],
  ["#e4dcff", 2, [0, 3, -4]],
] as const) {
  const light = new THREE.DirectionalLight(color, intensity);
  light.position.set(position[0], position[1], position[2]);
  if (position[0] === 3) {
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.camera.left = light.shadow.camera.bottom = -3;
    light.shadow.camera.right = light.shadow.camera.top = 3;
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = 15;
    light.shadow.bias = -0.0002;
    light.shadow.normalBias = 0.01;
  }
  scene.add(light);
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: "#1a1b27", roughness: 0.84 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.018;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(16, 32, "#323144", "#232331");
grid.position.y = -0.017;
scene.add(grid);
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = new THREE.PerspectiveCamera(31, W / H, 0.01, 50);
const model = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}assets/gangnam-character.glb`);
model.scene.traverse((object) => {
  if ((object as THREE.Mesh).isMesh) {
    object.castShadow = true;
    object.receiveShadow = true;
  }
});
scene.add(model.scene);
const rig = new MotionRig(model.scene, model.animations);
type Cue = { start: number; duration: number; instruction: string };
let program = createGangnam();
let timeline = compileMotion(program);
let cues: Cue[] = [];
let orbit = true;
let fixedAngle = 0.14;
let clean = false;
type ReferenceCamera = { height: number; position: [number, number, number]; target: [number, number, number] };
let referenceCamera: ReferenceCamera | undefined;
type CaptureFrame = { phase: string; image: string; file?: string; capturedAtMs?: number };
type CaptureCommand = { instruction: string; output: string; frames: CaptureFrame[] };
type LoadedFrame = CaptureFrame & { bitmap: HTMLImageElement };
let interaction: (Omit<CaptureCommand, "frames"> & { frames: LoadedFrame[] })[] = [];
let launch: ReturnType<typeof createGangnamLaunch>["launch"] | undefined;
const inputBox = { x: 36, y: 928, width: 1008, height: 124 };

// These are screenshots of actual keyboard/mouse events in the public form.
// Editing retimes typing and inference waits; it does not synthesize an Apply UI.
async function loadInteraction(recording: { width: number; height: number; commands: CaptureCommand[] }) {
  if (recording.width !== inputBox.width || recording.height !== inputBox.height)
    throw new Error("Expected the recorded public input strip at 1008 × 124.");
  const expected = ["Dance Gangnam Style.", "Now on one foot.", "Switch to the opposite foot."];
  if (recording.commands.length !== expected.length || recording.commands.some((command, index) => command.instruction !== expected[index]))
    throw new Error("The launch recording must contain the three exact demonstrated commands.");
  interaction = await Promise.all(recording.commands.map(async (command) => ({
    ...command,
    frames: await Promise.all(command.frames.map(async (frame) => {
      const bitmap = new Image();
      bitmap.src = frame.image;
      await bitmap.decode();
      if (bitmap.width !== inputBox.width || bitmap.height !== inputBox.height)
        throw new Error("A recorded input frame has unexpected dimensions.");
      return { ...frame, bitmap };
    })),
  })));
  for (const command of interaction)
    for (const phase of ["editing", "typed", "pressed", "done"])
      if (!command.frames.some((frame) => frame.phase === phase)) throw new Error(`Missing captured ${phase} frame.`);
}

function interactionAt(t: number) {
  if (!launch || !interaction.length) return undefined;
  let index = 0;
  let phase = "done";
  let fraction = 1;
  for (let edit = 0; edit < launch.edits.length; edit++) {
    const start = launch.edits[edit].start;
    if (t < start - 1.35) break;
    index = edit + 1;
    if (t < start - 1.20) { phase = "focusing"; fraction = (t - (start - 1.35)) / .15; }
    else if (t < start - 1.05) phase = "selected";
    else if (t < start - .65) { phase = "editing"; fraction = (t - (start - 1.05)) / .40; }
    else if (t < start - .45) phase = "typed";
    else if (t < start - .30) { phase = "moving"; fraction = (t - (start - .45)) / .15; }
    else if (t < start - .17) phase = "pressed";
    else if (t < start) phase = "applying";
    else phase = "done";
  }
  if (phase === "focusing" && !interaction[index].frames.some((frame) => frame.phase === phase)) { index--; phase = "done"; fraction = 1; }
  const command = interaction[index];
  if (phase === "selected" && !command.frames.some((frame) => frame.phase === phase)) { phase = "editing"; fraction = 0; }
  if (phase === "moving" && !command.frames.some((frame) => frame.phase === phase)) phase = "typed";
  // A cached response can complete before the browser paints a busy state.
  // Retain the recorded click until confirmation instead of inventing one.
  if (phase === "applying" && !command.frames.some((frame) => frame.phase === phase)) phase = "pressed";
  const frames = command.frames.filter((frame) => frame.phase === phase);
  const frame = frames[Math.min(frames.length - 1, Math.floor(fraction * frames.length))];
  return { command: command.instruction, phase, frame };
}

function initialize(
  input?: { program?: MotionProgram; cues?: Cue[]; camera?: ReferenceCamera; launchPrograms?: Parameters<typeof createGangnamLaunch>[0] },
  _side = "left",
  variation = "classic",
  options: { fixedCamera?: boolean; clean?: boolean } = {},
) {
  clean = options.clean ?? false;
  const classic = createGangnam();
  const oneFoot = createGangnam({ support: "left" });
  const sequence = variation === "sequence" && !input?.program ? createGangnamLaunch(input?.launchPrograms) : undefined;
  launch = sequence?.launch;
  program = input?.program ?? sequence?.program ?? (variation === "one-foot" ? oneFoot : classic);
  timeline = validateRigProgram(program);
  referenceCamera = input?.camera ?? (launch ? {
    height: 2.22, position: [0, 1.06, 6], target: [0, .76, 0],
  } : undefined);
  (floor.material as THREE.MeshStandardMaterial).color.set(launch ? "#454b59" : "#1a1b27");
  grid.visible = !launch;
  if (referenceCamera) {
    const { height, position, target } = referenceCamera;
    if (!Number.isFinite(height) || height <= 0 || height > 20 ||
      !Array.isArray(position) || !Array.isArray(target) ||
      position.length !== 3 || target.length !== 3 ||
      ![...position, ...target].every(Number.isFinite))
      throw new Error("Expected a finite reference camera and positive view height.");
    const half = height / 2;
    camera = new THREE.OrthographicCamera(-half * W / H, half * W / H, half, -half, 0.01, 50);
  } else camera = new THREE.PerspectiveCamera(31, W / H, 0.01, 50);
  cues = sequence?.cues ?? (input?.program ? (input.cues?.length ? input.cues : [
    { start: 0, duration: timeline.duration, instruction: program.title },
  ]) : [{ start: 0, duration: timeline.duration, instruction: variation === "one-foot" ? "Gangnam Style. On one foot." : "Dance Gangnam Style." }]);
  orbit = !launch && !options.fixedCamera && variation !== "one-foot";
  fixedAngle = options.fixedCamera ? 0 : 0.14;
  return { program, cues, launch, inputBox, width: W, height: H, duration: timeline.duration };
}
function pose(time: number) {
  const t = THREE.MathUtils.clamp(time, 0, timeline.duration);
  rig.apply(sampleTimeline(timeline, t), sampleContacts(timeline, t), timeline.props);
  if (referenceCamera) {
    camera.position.fromArray(referenceCamera.position);
    camera.lookAt(new THREE.Vector3().fromArray(referenceCamera.target));
  } else {
    const angle = orbit ? 0.14 + Math.sin(Math.min(t / 6, 1) * Math.PI * 2) * 0.31 : fixedAngle;
    camera.position.set(Math.sin(angle) * 4.6, 1.42, Math.cos(angle) * 4.6);
    camera.lookAt(0, 0.96, 0);
  }
  renderer.render(scene, camera);
  return t;
}
function render(time: number, format: "jpeg" | "png" = "jpeg") {
  const t = pose(time);
  ctx.drawImage(renderer.domElement, 0, 0);
  if (clean) return out.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.96).split(",")[1];
  const fade = ctx.createLinearGradient(0, launch ? 910 : 875, 0, H);
  fade.addColorStop(0, "rgba(16,17,25,0)");
  fade.addColorStop(1, "rgba(16,17,25,0.96)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, launch ? 910 : 875, W, H);
  ctx.fillStyle = "#b9a2ef";
  ctx.font = "500 18px sans-serif";
  ctx.fillText("PAW / Avatar Director", 36, 36);
  ctx.textAlign = "right";
  ctx.fillStyle = "#9491a3";
  ctx.font = "16px sans-serif";
  if (!launch) ctx.fillText("programasweights.com/avatar", W - 36, 36);
  ctx.textAlign = "left";
  const recorded = interactionAt(t);
  if (recorded) {
    ctx.drawImage(recorded.frame.bitmap, inputBox.x, inputBox.y, inputBox.width, inputBox.height);
    return out.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.96).split(",")[1];
  }
  const cue = cues.find((item) => t >= item.start && t < item.start + item.duration) ?? cues.at(-1);
  ctx.fillStyle = "#f7f6fc";
  ctx.font = "600 42px sans-serif";
  ctx.fillText(cue?.instruction ?? program.title, 42, 1029);
  return out.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.96).split(",")[1];
}
(window as any).__sequence = {
  initialize, render, rig, loadInteraction,
  inspect: (time: number, checkFraming = false) => {
    pose(time);
    const recorded = interactionAt(time);
    let frameBounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
    if (checkFraming) {
      frameBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      const point = new THREE.Vector3();
      model.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
          mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld).project(camera);
          const x = (point.x + 1) * W / 2, y = (1 - point.y) * H / 2;
          frameBounds!.minX = Math.min(frameBounds!.minX, x);
          frameBounds!.maxX = Math.max(frameBounds!.maxX, x);
          frameBounds!.minY = Math.min(frameBounds!.minY, y);
          frameBounds!.maxY = Math.max(frameBounds!.maxY, y);
        }
      });
    }
    return { joints: rig.snapshot(), camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
      type: camera.type, viewHeight: camera instanceof THREE.OrthographicCamera ? camera.top - camera.bottom : null },
      frameBounds,
      interaction: recorded ? { instruction: recorded.command, phase: recorded.phase, file: recorded.frame.file } : null,
      cue: cues.find((item) => time >= item.start && time < item.start + item.duration)?.instruction ?? cues.at(-1)?.instruction,
    };
  },
};
