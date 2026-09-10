// Offline reference fitting. This consumes measured landmarks; it never runs
// a neural model and does not alter the live dance or its compiled interpreters.
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MotionRig } from "../src/motion/rig";
import { createGangnam } from "../src/motion/gangnam";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { validateRigProgram } from "../src/motion/director";
import type { Axis, CurveNode, GroupNode, MotionNode, MotionProgram, PoseValue } from "../src/motion/types";

export interface Landmark { x: number; y: number; z?: number; visibility?: number; presence?: number }
export interface ReferenceFrame {
  time: number;
  landmarks: (Landmark | null)[];
  worldLandmarks: (Landmark | null)[];
}
export interface OrientationKey {
  time: number;
  head: { yaw: number; pitch: number; roll: number };
  torso: { yaw: number };
}
export interface ReferenceInput {
  fps: number;
  width: number;
  height: number;
  source?: { url?: string; start?: number; end?: number; [key: string]: unknown };
  frames: ReferenceFrame[];
  orientation?: OrientationKey[];
}
export interface ManualReferenceInput {
  fps: number;
  width: number;
  height: number;
  source?: ReferenceInput["source"];
  manualFrames: { time: number; points: Record<string, [number, number]>; notes?: string }[];
  cameraStabilization?: { frames: { time: number; to_first: number[][] }[] };
  orientation?: OrientationKey[];
}
export interface FitOptions {
  maxFrames?: number;
  bpm?: number;
  confidence?: number;
  groundPixelY?: number;
  floorThreshold?: number;
  smoothRadius?: number;
  noseHeightAboveHead?: number;
}
const IDS = {
  nose: 0, left_ear: 7, right_ear: 8,
  left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14,
  left_wrist: 15, right_wrist: 16, left_pinky: 17, right_pinky: 18,
  left_index: 19, right_index: 20, left_thumb: 21, right_thumb: 22,
  left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28, left_heel: 29, right_heel: 30,
  left_toes: 31, right_toes: 32,
} as const;
type Joint = keyof typeof IDS;
const SIDES = ["left", "right"] as const;
const AXES: Axis[] = ["x", "y", "z"];
const v = () => new Vector3();
const q = () => new Quaternion();
const mid = (a: Vector3, b: Vector3) => a.clone().add(b).multiplyScalar(.5);
const median = (values: number[]) => quantile(values, .5);
function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))];
}
function valid(point: Landmark | null | undefined, confidence = 0) {
  return !!point && [point.x, point.y, point.z ?? 0].every(Number.isFinite)
    && Math.min(point.visibility ?? 1, point.presence ?? 1) >= confidence;
}
function direction(a: Vector3, b: Vector3, fallback: Vector3) {
  const delta = b.clone().sub(a);
  return delta.lengthSq() > 1e-8 ? delta.normalize() : fallback.clone().normalize();
}
function orientation(across: Vector3, up: Vector3) {
  const y = up.clone().normalize(), x = across.clone().addScaledVector(y, -across.dot(y)).normalize();
  const z = x.clone().cross(y).normalize();
  if (Math.min(x.lengthSq(), y.lengthSq(), z.lengthSq()) < .5) return q();
  return q().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}
function angles(rotation: Quaternion) {
  const euler = new Euler().setFromQuaternion(rotation, "XYZ");
  return [euler.x, euler.y, euler.z].map(MathUtils.radToDeg);
}
const values = (target: string, channel: "rotation" | "position", vector: number[]): PoseValue[] =>
  AXES.map((axis, i) => ({ target, channel, axis, value: vector[i] }));

/** Input validation and coordinate conversion, separately inspectable before fitting. */
export function prepareReference(input: ReferenceInput, options: FitOptions = {}) {
  if (!input || !Array.isArray(input.frames) || input.frames.length < 2)
    throw new Error("Provide at least two timestamped landmark frames.");
  if (![input.width, input.height, input.fps].every(n => Number.isFinite(n) && n > 0))
    throw new Error("Reference width, height and fps must be positive.");
  const start = input.frames[0].time;
  let previous = -Infinity;
  for (const frame of input.frames) {
    if (!Number.isFinite(frame.time) || frame.time <= previous)
      throw new Error("Reference timestamps must increase strictly.");
    previous = frame.time;
    if (!Array.isArray(frame.landmarks) || !Array.isArray(frame.worldLandmarks))
      throw new Error("Each frame needs image landmarks and worldLandmarks arrays.");
  }
  const duration = previous - start;
  if (!(duration > 0 && duration <= 30)) throw new Error("Fit a short reference, at most30seconds.");
  const maxFrames = Math.min(250, Math.max(2, options.maxFrames ?? 240));
  const count = Math.min(maxFrames, input.frames.length);
  const frames = Array.from({ length: count }, (_, index) => input.frames[Math.round(index * (input.frames.length - 1) / (count - 1))]);
  const confidence = options.confidence ?? .35;
  const inferred: { frame: number; joint: Joint; space: string }[] = [];
  const pointAt = (index: number, joint: Joint, space: "landmarks" | "worldLandmarks") => {
    const id = IDS[joint];
    let point = frames[index][space][id];
    if (!valid(point, confidence)) {
      let before = index - 1, after = index + 1;
      while (before >= 0 && !valid(frames[before][space][id], confidence)) before--;
      while (after < frames.length && !valid(frames[after][space][id], confidence)) after++;
      if (before < 0 && after === frames.length) throw new Error(`No reliable ${space} observations for ${joint}.`);
      const a = frames[Math.max(0, before >= 0 ? before : after)][space][id]!;
      const b = frames[Math.min(frames.length - 1, after < frames.length ? after : before)][space][id]!;
      const ratio = before < 0 ? 1 : after === frames.length ? 0
        : (frames[index].time - frames[before].time) / (frames[after].time - frames[before].time);
      point = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio, z: (a.z ?? 0) + ((b.z ?? 0) - (a.z ?? 0)) * ratio };
      inferred.push({ frame: index, joint, space });
    }
    // MediaPipe uses image-right/down/away. The stage is right/up/toward-camera.
    return space === "worldLandmarks"
      ? new Vector3(point!.x, -point!.y, -(point!.z ?? 0))
      : new Vector3(point!.x * input.width, point!.y * input.height, point!.z ?? 0);
  };
  const required: Joint[] = SIDES.flatMap(side => [
    `${side}_shoulder`, `${side}_elbow`, `${side}_wrist`, `${side}_hip`, `${side}_knee`, `${side}_ankle`,
  ] as Joint[]);
  const prepared = frames.map((frame, index) => ({
    time: frame.time - start,
    world: Object.fromEntries(required.map(joint => [joint, pointAt(index, joint, "worldLandmarks")])) as Record<Joint, Vector3>,
    image: Object.fromEntries(required.map(joint => [joint, pointAt(index, joint, "landmarks")])) as Record<Joint, Vector3>,
    optional: Object.fromEntries((Object.keys(IDS) as Joint[]).filter(joint => !required.includes(joint)).flatMap(joint => {
      const point = frame.worldLandmarks[IDS[joint]];
      return valid(point, confidence) ? [[joint, new Vector3(point!.x, -point!.y, -(point!.z ?? 0))]] : [];
    })) as Partial<Record<Joint, Vector3>>,
  }));
  // Symmetric smoothing does not add the phase lag of a rolling average.
  const radius = Math.max(0, Math.min(3, options.smoothRadius ?? 1));
  if (radius) for (const space of ["world", "image"] as const) {
    const original = prepared.map(frame => Object.fromEntries(required.map(joint => [joint, frame[space][joint].clone()])) as Record<Joint, Vector3>);
    for (let frame = 0; frame < prepared.length; frame++) for (const joint of required) {
      const average = v(); let weight = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const at = frame + offset;
        if (at < 0 || at >= prepared.length) continue;
        const w = Math.exp(-.5 * (offset / Math.max(1, radius * .6)) ** 2);
        average.addScaledVector(original[at][joint], w); weight += w;
      }
      prepared[frame][space][joint] = average.multiplyScalar(1 / weight);
    }
  }
  return { frames: prepared, duration, inferred, source: input.source ?? {}, inputFrames: input.frames.length };
}


/** Manual image measurements constrain projection only. The depth choices below
 * are explicit weak priors, not recovered motion-capture coordinates. */
export function adaptManualReference(rig: MotionRig, input: ManualReferenceInput) {
  if (!Array.isArray(input.manualFrames) || input.manualFrames.length < 2)
    throw new Error("Provide at least two timestamped manual frames.");
  for (const frame of input.manualFrames) for (const side of SIDES)
    for (const joint of ["shoulder", "elbow", "wrist", "hip", "knee", "ankle"]) {
      const key = `${side}_${joint}`, point = frame.points?.[key];
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
        throw new Error(`Manual frame ${frame.time} needs a finite pixel pair for ${key}.`);
    }
  rig.apply([]);
  const rest = rig.snapshot();
  const rp = (joint: string) => new Vector3(...rest[joint].position as [number, number, number]);
  const torso = mid(rp("left_shoulder"), rp("right_shoulder")).distanceTo(rp("hips"));
  const stabilize = (point: [number, number], time: number): [number, number] => {
    const camera = input.cameraStabilization?.frames;
    if (!camera?.length) return point;
    const upper = camera.findIndex(frame => frame.time >= time);
    const b = upper < 0 ? camera.at(-1)! : camera[upper];
    const a = camera[Math.max(0, upper - 1)];
    const p = a.time === b.time ? 0 : MathUtils.clamp((time - a.time) / (b.time - a.time), 0, 1);
    const m = a.to_first.map((row, i) => row.map((value, j) => value + (b.to_first[i][j] - value) * p));
    const denominator = m[2][0] * point[0] + m[2][1] * point[1] + m[2][2];
    return [(m[0][0] * point[0] + m[0][1] * point[1] + m[0][2]) / denominator,
      (m[1][0] * point[0] + m[1][1] * point[1] + m[1][2]) / denominator];
  };
  const measurements = input.manualFrames.map(frame => ({ ...frame,
    points: Object.fromEntries(Object.entries(frame.points).map(([name, point]) => [name, stabilize(point, frame.time)])),
  }));
  const torsoPixels = measurements.map(({ points: p }) => Math.hypot(
    (p.left_shoulder[0] + p.right_shoulder[0] - p.left_hip[0] - p.right_hip[0]) / 2,
    (p.left_shoulder[1] + p.right_shoulder[1] - p.left_hip[1] - p.right_hip[1]) / 2,
  ));
  if (!(median(torsoPixels) > 1)) throw new Error("Manual shoulder and hip centers must define a visible torso length.");
  const scale = torso / median(torsoPixels);
  const projectedClamps: { time: number; joint: string; ratio: number }[] = [];
  const frames = measurements.map(frame => {
    const hipX = (frame.points.left_hip[0] + frame.points.right_hip[0]) / 2;
    const hipY = (frame.points.left_hip[1] + frame.points.right_hip[1]) / 2;
    const world: Record<string, Vector3> = {};
    for (const [name, point] of Object.entries(frame.points))
      world[name] = new Vector3((point[0] - hipX) * scale, -(point[1] - hipY) * scale, 0);
    const extend = (from: string, to: string, length: number, sign: number) => {
      const a = frame.points[from], b = frame.points[to];
      let dx = (b[0] - a[0]) * scale, dy = -(b[1] - a[1]) * scale;
      const projected = Math.hypot(dx, dy);
      if (projected > length * .985) {
        const ratio = length * .985 / projected;
        dx *= ratio; dy *= ratio;
        projectedClamps.push({ time: frame.time, joint: to, ratio });
      }
      const depth = Math.sqrt(Math.max(0, length * length - dx * dx - dy * dy));
      world[to] = world[from].clone().add(new Vector3(dx, dy, sign * depth));
    };
    for (const side of SIDES) {
      extend(`${side}_hip`, `${side}_knee`, rp(`${side}_hip`).distanceTo(rp(`${side}_knee`)), 1);
      extend(`${side}_knee`, `${side}_ankle`, rp(`${side}_knee`).distanceTo(rp(`${side}_ankle`)), -1);
      // Elbows and reins are in front of the torso. An overhead arm stays
      // nearer the frontal plane. The source does not determine this depth.
      extend(`${side}_shoulder`, `${side}_elbow`, rp(`${side}_shoulder`).distanceTo(rp(`${side}_elbow`)), 1);
      const raised = frame.points[`${side}_wrist`][1] < frame.points[`${side}_shoulder`][1] - 12;
      extend(`${side}_elbow`, `${side}_wrist`, rp(`${side}_elbow`).distanceTo(rp(`${side}_wrist`)), raised ? -1 : 1);
    }
    const landmarks: (Landmark | null)[] = Array.from({ length: 33 }, () => null);
    const worldLandmarks: (Landmark | null)[] = Array.from({ length: 33 }, () => null);
    for (const [name, id] of Object.entries(IDS)) {
      const point = frame.points[name], estimated = world[name];
      if (!point || !estimated) continue;
      landmarks[id] = { x: point[0] / input.width, y: point[1] / input.height, visibility: 1 };
      worldLandmarks[id] = { x: estimated.x, y: -estimated.y, z: -estimated.z, visibility: 1 };
    }
    return { time: frame.time, landmarks, worldLandmarks };
  });
  return { input: { fps: input.fps, width: input.width, height: input.height, source: input.source, frames, orientation: input.orientation } as ReferenceInput,
    report: { method: "Manual2D measurements with explicit weak-depth limb priors; no neural inference or measured3D depth", cameraCompensation: !!input.cameraStabilization,
      projectedClamps, measurements, metersPerPixel: scale } };
}
function coordinateDescent(initial: number[], loss: (angles: number[]) => number, bounds: number[], first: boolean) {
  let candidate = [...initial], best = loss(candidate);
  for (const step of first ? [24, 12, 6, 3, 1, .3] : [8, 4, 2, .6]) {
    for (let pass = 0; pass < (first ? 10 : 5); pass++) {
      let changed = false;
      for (let axis = 0; axis < candidate.length; axis++) {
        const baseline = candidate[axis];
        for (const sign of [-1, 1]) {
          const trial = [...candidate]; trial[axis] = baseline + sign * step;
          if (Math.abs(trial[axis]) > bounds[axis]) continue;
          const error = loss(trial);
          if (error < best) { best = error; candidate = trial; changed = true; }
        }
      }
      if (!changed) break;
    }
  }
  return { angles: candidate, loss: best };
}

function orientationAt(keys: OrientationKey[] | undefined, time: number) {
  if (!keys?.length) return undefined;
  const after = keys.findIndex(key => key.time >= time);
  const b = keys[after < 0 ? keys.length - 1 : after];
  const a = keys[Math.max(0, after < 0 ? keys.length - 1 : after - 1)];
  const ratio = a.time === b.time ? 0 : MathUtils.clamp((time - a.time) / (b.time - a.time), 0, 1);
  const mix = (x: number, y: number) => x + (y - x) * ratio;
  const head = { yaw: mix(a.head.yaw, b.head.yaw), pitch: mix(a.head.pitch, b.head.pitch), roll: mix(a.head.roll, b.head.roll) };
  return { head, torso: { yaw: mix(a.torso.yaw, b.torso.yaw) } };
}

/** Fit measured directions to the actual rig, never copying source bone lengths. */
export async function fitReference(rig: MotionRig, source: ReferenceInput | ManualReferenceInput, options: FitOptions = {}, progress?: (value: unknown) => void) {
  const manual = "manualFrames" in source ? adaptManualReference(rig, source) : undefined;
  const input = manual?.input ?? source as ReferenceInput;
  if (input.orientation) {
    let previous = -Infinity;
    for (const key of input.orientation) {
      if (![key.time, key.head?.yaw, key.head?.pitch, key.head?.roll, key.torso?.yaw].every(Number.isFinite) || key.time <= previous)
        throw new Error("Orientation keys must have finite angles and strictly increasing timestamps.");
      previous = key.time;
    }
  }
  const reference = prepareReference(input, options);
  rig.apply([]);
  const rest = rig.snapshot();
  const position = (joint: string) => new Vector3(...rest[joint].position as [number, number, number]);
  const lengths = Object.fromEntries(SIDES.map(side => [side, {
    upperArm: position(`${side}_shoulder`).distanceTo(position(`${side}_elbow`)),
    forearm: position(`${side}_elbow`).distanceTo(position(`${side}_wrist`)),
    thigh: position(`${side}_hip`).distanceTo(position(`${side}_knee`)),
    shin: position(`${side}_knee`).distanceTo(position(`${side}_ankle`)),
  }]));
  const restHip = position("hips");
  const restShoulders = mid(position("left_shoulder"), position("right_shoulder"));
  const restFrame = orientation(position("left_shoulder").sub(position("right_shoulder")), restShoulders.clone().sub(restHip));
  const sourceTorsoPixels = reference.frames.map(frame => mid(frame.image.left_shoulder, frame.image.right_shoulder)
    .distanceTo(mid(frame.image.left_hip, frame.image.right_hip)));
  const metersPerPixel = restShoulders.distanceTo(restHip) / median(sourceTorsoPixels);
  const floorY = options.groundPixelY ?? quantile(reference.frames.flatMap(frame => [frame.image.left_ankle.y, frame.image.right_ankle.y]), .98);
  // A ground plane is slanted in an oblique source view. Per-foot lower
  // envelopes avoid interpreting a farther planted foot as a permanent lift.
  // This is an image-space contact approximation, not recovered camera depth.
  const footFloorY = Object.fromEntries(SIDES.map(side => [side, options.groundPixelY
    ?? quantile(reference.frames.map(frame => frame.image[`${side}_ankle`].y), .96)])) as Record<"left" | "right", number>;
  const hipCenterX = median(reference.frames.map(frame => (frame.image.left_hip.x + frame.image.right_hip.x) / 2));
  const gripProgram = createGangnam();
  const gripNode = findNode(gripProgram.root, "details")!;
  const gripValues = sampleTimeline(compileMotion({ ...gripProgram, root: gripNode }), 0);
  const frames: { time: number; pose: PoseValue[] }[] = [];
  const armErrors: { time: number; side: string; elbow: number; wrist: number }[] = [];
  const contacts: { time: number; left: boolean; right: boolean }[] = [];
  const previousArms = { left: [-45, 0, 0, -40, 0, -20], right: [-45, 0, 0, -40, 0, 20] };
  const anchors: Partial<Record<"left" | "right", Vector3>> = {};
  const previousContact = { left: false, right: false };
  const hipCenterY = median(reference.frames.map(frame => (frame.image.left_hip.y + frame.image.right_hip.y) / 2));
  const geometry = reference.frames.map(frame => {
    const world = frame.world;
    const sourceHip = mid(world.left_hip, world.right_hip), sourceShoulders = mid(world.left_shoulder, world.right_shoulder);
    const sourceFrame = orientation(world.left_shoulder.clone().sub(world.right_shoulder), sourceShoulders.clone().sub(sourceHip));
    const bodyRotation = sourceFrame.clone().multiply(restFrame.clone().invert());
    const bodyAngles = angles(bodyRotation).map((angle, axis) => MathUtils.clamp(angle, -[40, 70, 35][axis], [40, 70, 35][axis]));
    const annotated = orientationAt(input.orientation, frame.time + input.frames[0].time);
    if (annotated) {
      bodyAngles[1] = MathUtils.clamp(annotated.torso.yaw, -70, 70);
      bodyRotation.setFromEuler(new Euler(...bodyAngles.map(MathUtils.degToRad) as [number, number, number], "XYZ"));
    }
    const pose: PoseValue[] = [...gripValues, ...values("hips", "rotation", bodyAngles)];
    if (annotated) pose.push(...values("head", "rotation", [annotated.head.pitch - bodyAngles[0], annotated.head.yaw - bodyAngles[1], -annotated.head.roll - bodyAngles[2]]));
    rig.apply(pose);
    const base = rig.snapshot();
    const hips: Record<string, Vector3> = {}, knees: Record<string, Vector3> = {}, ankles: Record<string, Vector3> = {};
    const lift: Record<string, number> = {};
    for (const side of SIDES) {
      hips[side] = new Vector3(...base[`${side}_hip`].position as [number, number, number]);
      const thigh = direction(world[`${side}_hip`], world[`${side}_knee`], new Vector3(0, -1, 0));
      const shin = direction(world[`${side}_knee`], world[`${side}_ankle`], new Vector3(0, -1, 0));
      knees[side] = hips[side].clone().addScaledVector(thigh, lengths[side].thigh);
      ankles[side] = knees[side].clone().addScaledVector(shin, lengths[side].shin);
      lift[side] = Math.max(0, (footFloorY[side] - frame.image[`${side}_ankle`].y) * metersPerPixel);
    }
    const imageHipY = (hipCenterY - (frame.image.left_hip.y + frame.image.right_hip.y) / 2) * metersPerPixel;
    const rootOffsets = SIDES.map(side => position(`${side}_ankle`).y + lift[side] - ankles[side].y - imageHipY);
    return { frame, world, bodyRotation, pose, hips, knees, ankles, lift, imageHipY, rootOffsets };
  });
  // Preserve the measured hip trajectory. Switching the vertical anchor from
  // one estimated leg to the other creates artificial jumps when source depth
  // or body proportions differ. Fit one constant height instead.
  const rootHeightOffset = median(geometry.flatMap(frame => frame.rootOffsets));
  for (let index = 0; index < geometry.length; index++) {
    const { frame, world, bodyRotation, pose, hips, knees, ankles, lift, imageHipY } = geometry[index];
    const root = new Vector3(
      (((frame.image.left_hip.x + frame.image.right_hip.x) / 2) - hipCenterX) * metersPerPixel,
      rootHeightOffset + imageHipY,
      0,
    );
    pose.push(...values("root", "position", root.toArray()));
    const contact: Record<string, boolean> = {};
    for (const side of SIDES) {
      const target = ankles[side].clone().add(root);
      target.y = position(`${side}_ankle`).y + lift[side];
      contact[side] = lift[side] < (options.floorThreshold ?? .025);
      if (contact[side]) {
        if (!previousContact[side]) anchors[side] = target.clone();
        target.x = anchors[side]!.x; target.z = anchors[side]!.z;
        target.y = position(`${side}_ankle`).y;
      }
      previousContact[side] = contact[side];
      const offset = target.clone().sub(position(`${side}_ankle`));
      const leg = target.clone().sub(hips[side].clone().add(root)).normalize();
      const pole = knees[side].clone().sub(hips[side]);
      pole.addScaledVector(leg, -pole.dot(leg)).normalize();
      if (pole.lengthSq() < .1) pole.set(0, 0, 1);
      pose.push(...values(`${side}_foot_ik`, "position", offset.toArray()));
      pose.push(...values(`${side}_knee_pole`, "position", pole.toArray()));
    }
    contacts.push({ time: frame.time, left: contact.left, right: contact.right });
    rig.apply(pose);
    for (const side of SIDES) {
      const shoulder = rig.joints.get(`${side}_shoulder`)!, elbow = rig.joints.get(`${side}_elbow`)!, wrist = rig.joints.get(`${side}_wrist`)!;
      const raised = world[`${side}_wrist`].y > world[`${side}_shoulder`].y + .06;
      const targetElbow = shoulder.bone.getWorldPosition(v()).addScaledVector(direction(world[`${side}_shoulder`], world[`${side}_elbow`], new Vector3(0, -1, 0)), lengths[side].upperArm);
      const targetWrist = targetElbow.clone().addScaledVector(direction(world[`${side}_elbow`], world[`${side}_wrist`], new Vector3(0, -1, 0)), lengths[side].forearm);
      if (raised && frame.optional.nose) {
        // Above-head gestures are judged relative to the face. Preserve that
        // relationship across differing head/torso proportions instead of
        // copying an angle that leaves a large-headed avatar's hand at its ear.
        // The shipped character's nose is 7.2 cm above its head-bone origin.
        const head = rig.joints.get("head")!.bone.getWorldPosition(v());
        targetWrist.y = head.y + (options.noseHeightAboveHead ?? .072)
          + world[`${side}_wrist`].y - frame.optional.nose.y;
        const origin = shoulder.bone.getWorldPosition(v());
        const ray = targetWrist.clone().sub(origin);
        const length = Math.min(ray.length(), (lengths[side].upperArm + lengths[side].forearm) * .985);
        ray.normalize(); targetWrist.copy(origin).addScaledVector(ray, length);
        const along = (lengths[side].upperArm ** 2 - lengths[side].forearm ** 2 + length ** 2) / (2 * length);
        const bend = targetElbow.clone().sub(origin).addScaledVector(ray, -targetElbow.clone().sub(origin).dot(ray));
        if (bend.lengthSq() < 1e-8) bend.set(side === "left" ? 1 : -1, 0, 0);
        targetElbow.copy(origin).addScaledVector(ray, along)
          .addScaledVector(bend.normalize(), Math.sqrt(Math.max(0, lengths[side].upperArm ** 2 - along ** 2)));
      }
      const set = (ref: typeof shoulder, euler: number[]) => {
        const delta = q().setFromEuler(new Euler(...euler.map(MathUtils.degToRad) as [number, number, number], "XYZ"));
        ref.bone.quaternion.copy(ref.parentWorld.clone().invert().multiply(delta).multiply(ref.parentWorld).multiply(ref.rotation));
        ref.bone.updateWorldMatrix(true, true);
      };
      const prior = previousArms[side];
      const loss = (candidate: number[]) => {
        set(shoulder, candidate.slice(0, 3)); set(elbow, candidate.slice(3));
        return 2 * elbow.bone.getWorldPosition(v()).distanceToSquared(targetElbow)
          + 3 * wrist.bone.getWorldPosition(v()).distanceToSquared(targetWrist)
          + candidate.reduce((sum, angle, axis) => sum + (angle - prior[axis]) ** 2, 0) * 1e-8;
      };
      const fit = coordinateDescent(prior, loss, [175, 145, 165, 150, 125, 145], index === 0);
      previousArms[side] = fit.angles;
      loss(fit.angles);
      armErrors.push({ time: frame.time, side, elbow: elbow.bone.getWorldPosition(v()).distanceTo(targetElbow), wrist: wrist.bone.getWorldPosition(v()).distanceTo(targetWrist) });
      pose.push(...values(`${side}_shoulder`, "rotation", fit.angles.slice(0, 3)), ...values(`${side}_elbow`, "rotation", fit.angles.slice(3)));
      // Preserve the authored clenched fingers and a palm-down reins grip.
      // Wrist/hand depth is not claimed as a measured landmark in the manual fit.
      let wristAngles = [0, 0, 0];
      if (!raised) {
        const sideSign = side === "left" ? 1 : -1;
        const alongGoal = new Vector3(0, -.15, .989).applyQuaternion(bodyRotation);
        const acrossGoal = new Vector3(-sideSign, 0, 0).applyQuaternion(bodyRotation);
        const wristLoss = (candidate: number[]) => {
          set(wrist, candidate);
          const origin = wrist.bone.getWorldPosition(v());
          const along = rig.joints.get(`${side}_middle_1`)!.bone.getWorldPosition(v()).sub(origin).normalize();
          const across = rig.joints.get(`${side}_index_1`)!.bone.getWorldPosition(v()).sub(rig.joints.get(`${side}_pinky_1`)!.bone.getWorldPosition(v())).normalize();
          return along.distanceToSquared(alongGoal) + across.distanceToSquared(acrossGoal);
        };
        wristAngles = coordinateDescent([80, -sideSign * 40, sideSign * 80], wristLoss, [175, 175, 175], true).angles;
      }
      pose.push(...values(`${side}_wrist`, "rotation", wristAngles));
    }
    frames.push({ time: frame.time, pose });
    if (index % 12 === 0 || index === reference.frames.length - 1) {
      progress?.({ frame: index + 1, total: reference.frames.length });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  const duration = reference.duration;
  const byTarget = new Map<string, { target: string; axis: Axis; channel: "rotation" | "position"; points: [number, number][] }>();
  for (const frame of frames) for (const pose of frame.pose) {
    const key = `${pose.target}.${pose.channel}.${pose.axis}`;
    if (!byTarget.has(key)) byTarget.set(key, { ...pose, points: [] });
    const entry = byTarget.get(key)!;
    let value = pose.value;
    if (pose.channel === "rotation" && entry.points.length) {
      const previous = entry.points.at(-1)![1];
      while (value - previous > 180) value -= 360;
      while (value - previous < -180) value += 360;
    }
    entry.points.push([frame.time / duration, value]);
  }
  const branches: Record<string, MotionNode[]> = { feet: [], balance: [], body: [], left: [], right: [] };
  for (const track of byTarget.values()) {
    if (/_(thumb|index|middle|ring|pinky)_/.test(track.target)) continue;
    const node: CurveNode = { id: `reference.${track.target}.${track.axis}`, label: `${track.target.replaceAll("_", " ")} · ${track.axis}`, kind: "curve", target: track.target, axis: track.axis, channel: track.channel, duration,
      curve: { kind: "keys", interpolation: "linear", points: track.points } };
    if (track.target === "root") branches.balance.push(node);
    else if (/_foot_ik$|_knee_pole$|_ankle$/.test(track.target)) branches.feet.push(node);
    else if (/_(shoulder|elbow|wrist)$/.test(track.target)) branches[track.target.startsWith("left") ? "left" : "right"].push(node);
    else branches.body.push(node);
  }
  const group = (id: string, label: string, children: MotionNode[]): GroupNode => ({ id, label, kind: "parallel", children });
  const rescale = (node: MotionNode): MotionNode => node.kind === "curve" || node.kind === "contact"
    ? { ...node, duration } : { ...node, children: node.children.map(rescale) };
  const program: MotionProgram = {
    version: 2, title: "Gangnam Style · reference fit (review)", bpm: options.bpm ?? 132,
    root: group("motion", "Reference performance · measured timing", [
      group("feet", "Footwork · measured steps and contacts", branches.feet),
      group("torso", "Body · measured weight and orientation", [
        group("balance", "Balance · reference trajectory", branches.balance),
        group("torso.groove", "Torso · reference orientation", branches.body),
      ]),
      group("arms", "Arms · fitted reference directions", [group("arms.left", "Left arm", branches.left), group("arms.right", "Right arm", branches.right)]),
      rescale(gripNode),
    ]),
  };
  validateRigProgram(program);
  return { program, report: {
    source: reference.source, duration, sourceFrames: reference.inputFrames, fittedFrames: frames.length,
    metersPerPixel, groundPixelY: floorY, footGroundPixelY: footFloorY, rootHeightOffset, interpolatedObservations: reference.inferred,
    camera: { projection: "orthographic", height: input.height * metersPerPixel,
      center: [(input.width / 2 - hipCenterX) * metersPerPixel, position("left_ankle").y + (floorY - input.height / 2) * metersPerPixel, 0] },
    manual: manual?.report,
    orientation: input.orientation ? { method: "Explicit manually estimated camera-relative orientation; not measured3D", keys: input.orientation } : undefined,
    armErrors, contacts,
    reviewRequired: [input.orientation ? "Manually estimated head/torso orientation requires visual review" : "Face orientation is not yet reconstructed", "Reference-to-avatar side-by-side", "Support edits must preserve measured timing before promoting this optional program"],
  } };
}

const asset = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}assets/character.glb`);
const rig = new MotionRig(asset.scene, asset.animations);
(window as any).__referenceFit = { rig,
  prepareReference: (input: ReferenceInput | ManualReferenceInput, options: FitOptions) => prepareReference("manualFrames" in input ? adaptManualReference(rig, input).input : input, options),
  fit: (input: ReferenceInput | ManualReferenceInput, options: FitOptions) => fitReference(rig, input, options, value => (window as any).__fitProgress?.(value)) };
