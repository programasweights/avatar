// Render the same editable curves and character used by the live studio.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MotionRig } from "../src/motion/rig";
import { compileMotion, sampleContacts, sampleTimeline } from "../src/motion/engine";
import { createGangnam } from "../src/motion/gangnam";
import { validateRigProgram } from "../src/motion/director";
import type { MotionNode, MotionProgram } from "../src/motion/types";

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
function prefix(node: MotionNode, label: string): MotionNode {
  return node.kind === "curve" || node.kind === "contact"
    ? { ...node, id: `${label}.${node.id}` }
    : { ...node, id: `${label}.${node.id}`, children: node.children.map((child) => prefix(child, label)) };
}
function initialize(
  input?: { program: MotionProgram; cues?: Cue[]; camera?: ReferenceCamera },
  _side = "left",
  variation = "classic",
  options: { fixedCamera?: boolean; clean?: boolean } = {},
) {
  clean = options.clean ?? false;
  const classic = createGangnam();
  const oneFoot = createGangnam({ support: "left" });
  const duration = compileMotion(classic).duration;
  program = input?.program ?? (variation === "sequence" ? {
    version: 2,
    title: "Gangnam Style · now on one foot",
    bpm: classic.bpm,
    root: { id: "showcase", kind: "sequence", label: "Gangnam Style → one foot", children: [prefix(classic.root, "classic"), prefix(oneFoot.root, "one_foot")] },
  } : variation === "one-foot" ? oneFoot : classic);
  timeline = validateRigProgram(program);
  referenceCamera = input?.camera;
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
  cues = input ? (input.cues?.length ? input.cues : [
    { start: 0, duration: timeline.duration, instruction: program.title },
  ]) : (variation === "sequence" ? [
    { start: 0, duration, instruction: "Dance Gangnam Style." },
    { start: duration, duration, instruction: "Now on one foot." },
  ] : [{ start: 0, duration: timeline.duration, instruction: variation === "one-foot" ? "Gangnam Style. On one foot." : "Dance Gangnam Style." }]);
  orbit = !options.fixedCamera && variation !== "one-foot";
  fixedAngle = options.fixedCamera ? 0 : 0.14;
  return { program, cues, width: W, height: H, duration: timeline.duration };
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
  const fade = ctx.createLinearGradient(0, 875, 0, H);
  fade.addColorStop(0, "rgba(16,17,25,0)");
  fade.addColorStop(1, "rgba(16,17,25,0.96)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 875, W, H - 875);
  ctx.fillStyle = "#b9a2ef";
  ctx.font = "500 18px sans-serif";
  ctx.fillText("AVATAR DIRECTOR", 42, 49);
  ctx.textAlign = "right";
  ctx.fillStyle = "#9491a3";
  ctx.font = "16px sans-serif";
  ctx.fillText("programasweights.com/avatar", W - 42, 49);
  ctx.textAlign = "left";
  const cue = cues.find((item) => t >= item.start && t < item.start + item.duration) ?? cues.at(-1);
  ctx.fillStyle = "#b9a2ef";
  ctx.font = "500 17px sans-serif";
  ctx.fillText(cue && cue.start > 0 ? "NEXT DIRECTION" : "YOUR DIRECTION", 42, 969);
  ctx.fillStyle = "#f7f6fc";
  ctx.font = "600 42px sans-serif";
  ctx.fillText(cue?.instruction ?? program.title, 42, 1029);
  return out.toDataURL(format === "png" ? "image/png" : "image/jpeg", 0.96).split(",")[1];
}
(window as any).__sequence = {
  initialize, render, rig,
  inspect: (time: number) => {
    pose(time);
    return { joints: rig.snapshot(), camera: { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() } };
  },
};
