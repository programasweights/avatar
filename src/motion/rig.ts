import {
  AnimationMixer,
  Bone,
  Euler,
  MathUtils,
  Object3D,
  Quaternion,
  Vector3,
} from "three";
import type { AnimationClip } from "three";
import type { ContactValue, MotionProp, PoseValue } from "./types";
import { solveContacts } from "./contacts";
import { RigProps } from "./props";

import {
  JOINTS,
  identifyRig,
  standNaturally,
  fingerBasis,
} from "./rigDefinition";
export { JOINTS } from "./rigDefinition";

export const JOINT_LABEL = (id: string) =>
  id.replaceAll("_", " ").replace(/\b\w/g, (x) => x.toUpperCase());
export const VALID_TARGETS = new Set([
  ...Object.keys(JOINTS),
  "root",
  "left_foot_ik",
  "right_foot_ik",
  "left_knee_pole",
  "right_knee_pole",
  "left_hand_camera",
  "right_hand_camera",
]);
interface Reference {
  basis: Quaternion;
  bone: Bone;
  position: Vector3;
  rotation: Quaternion;
  world: Quaternion;
  parentWorld: Quaternion;
  worldPosition: Vector3;
}
const v = () => new Vector3();
const q = () => new Quaternion();

export class MotionRig {
  readonly joints = new Map<string, Reference>();
  readonly scene: Object3D;
  private rootReference: Vector3;
  private rootQuaternion: Quaternion;
  readonly props: RigProps;
  constructor(scene: Object3D, clips: AnimationClip[]) {
    this.scene = scene;
    const { joints: bones, imported } = identifyRig(scene);
    const idle = clips.find((clip) => clip.name === "idle");
    if (imported && !idle)
      throw new Error(
        "The imported Mixamo rig needs its neutral idle reference.",
      );
    if (idle) {
      const mixer = new AnimationMixer(scene);
      mixer.clipAction(idle).play();
      mixer.setTime(0);
      const poses = new Map<Object3D, { p: Vector3; q: Quaternion }>();
      scene.traverse((b) =>
        poses.set(b, { p: b.position.clone(), q: b.quaternion.clone() }),
      );
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
      poses.forEach((pose, bone) => {
        bone.position.copy(pose.p);
        bone.quaternion.copy(pose.q);
      });
    }
    scene.updateMatrixWorld(true);
    if (!imported) standNaturally(bones);
    scene.updateMatrixWorld(true);
    for (const [id, bone] of bones) {
      this.joints.set(id, {
        basis: imported ? q() : fingerBasis(bones, id),
        bone,
        position: bone.position.clone(),
        rotation: bone.quaternion.clone(),
        world: bone.getWorldQuaternion(q()),
        parentWorld: bone.parent!.getWorldQuaternion(q()),
        worldPosition: bone.getWorldPosition(v()),
      });
    }
    this.rootReference = scene.position.clone();
    this.rootQuaternion = scene.quaternion.clone();
    this.props = new RigProps(scene, this.joints);
    scene.traverse((object) => {
      if ("isMesh" in object) {
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false;
      }
    });
  }
  apply(
    values: PoseValue[],
    contacts: ContactValue[] = [],
    props: MotionProp[] = [],
  ) {
    this.scene.position.copy(this.rootReference);
    this.scene.quaternion.copy(this.rootQuaternion);
    this.joints.forEach((ref) => {
      ref.bone.position.copy(ref.position);
      ref.bone.quaternion.copy(ref.rotation);
    });
    const rotations = new Map<string, Vector3>();
    const positions = new Map<string, Vector3>();
    for (const value of values) {
      const map = value.channel === "rotation" ? rotations : positions;
      if (!map.has(value.target)) map.set(value.target, v());
      map.get(value.target)![value.axis] = value.value;
    }
    const rootPosition = positions.get("root");
    if (rootPosition) this.scene.position.add(rootPosition);
    let rootRotation: Quaternion | undefined;
    for (const [id, degrees] of rotations) {
      const delta = q().setFromEuler(
        new Euler(
          ...(degrees.toArray().map(MathUtils.degToRad) as [
            number,
            number,
            number,
          ]),
          "XYZ",
        ),
      );
      if (id === "root") {
        rootRotation = delta;
        this.scene.quaternion.premultiply(delta);
        continue;
      }
      const ref = this.joints.get(id);
      if (!ref || /_(hip|knee|ankle)$/.test(id)) continue;
      // Body axes are converted into the joint's neutral parent frame. Fingers
      // instead use their local rig axes, making curl a simple local-Z control.
      if (/_(thumb|index|middle|ring|pinky)_/.test(id))
        ref.bone.quaternion.multiply(
          ref.basis
            .clone()
            .multiply(delta)
            .multiply(ref.basis.clone().invert()),
        );
      else
        ref.bone.quaternion.copy(
          ref.parentWorld
            .clone()
            .invert()
            .multiply(delta)
            .multiply(ref.parentWorld)
            .multiply(ref.rotation),
        );
    }
    for (const [id, offset] of positions) {
      if (id === "root" || id.endsWith("_ik")) continue;
      const ref = this.joints.get(id);
      if (ref) {
        const parent = ref.bone.parent!;
        parent.updateWorldMatrix(true, false);
        const localOffset = parent
          .worldToLocal(offset.clone())
          .sub(parent.worldToLocal(new Vector3()));
        ref.bone.position.add(localOffset);
      }
    }
    this.scene.updateMatrixWorld(true);
    for (const side of ["left", "right"]) {
      const offset = positions.get(`${side}_foot_ik`);
      if (offset) {
        const ankle = this.joints.get(`${side}_ankle`)!;
        // Targets stay planted in stage coordinates while hips transfer weight.
        const target = ankle.worldPosition.clone().add(offset);
        // Turning changes the orientation of the walking frame. Translation
        // stays independent so planted targets still support weight shifts.
        if (rootRotation)
          target
            .sub(this.rootReference)
            .applyQuaternion(rootRotation)
            .add(this.rootReference);
        this.solveLeg(side, target, rootRotation, positions.get(`${side}_knee_pole`));
      }
    }
    // Explicit leg rotation tracks are FK edits on top of the solved stance.
    // They must not disappear when foot-contact constraints are present.
    for (const [id, degrees] of rotations) {
      if (!/_(hip|knee|ankle)$/.test(id)) continue;
      const ref = this.joints.get(id);
      if (!ref) continue;
      const delta = q().setFromEuler(
        new Euler(
          ...(degrees.toArray().map(MathUtils.degToRad) as [
            number,
            number,
            number,
          ]),
          "XYZ",
        ),
      );
      if (rootRotation)
        delta.premultiply(rootRotation).multiply(rootRotation.clone().invert());
      const parentWorld = ref.bone.parent!.getWorldQuaternion(q());
      ref.bone.quaternion.premultiply(
        parentWorld.clone().invert().multiply(delta).multiply(parentWorld),
      );
      ref.bone.updateWorldMatrix(false, true);
    }
    this.scene.updateMatrixWorld(true);
    solveContacts(this.joints, contacts);
    this.props.apply(props, contacts, values);
  }
  private rotateToward(bone: Bone, child: Bone, target: Vector3) {
    const origin = bone.getWorldPosition(v());
    const from = child.getWorldPosition(v()).sub(origin).normalize();
    const to = target.clone().sub(origin).normalize();
    const delta = q().setFromUnitVectors(from, to);
    const world = bone.getWorldQuaternion(q()).premultiply(delta);
    bone.quaternion.copy(
      bone.parent!.getWorldQuaternion(q()).invert().multiply(world),
    );
    bone.updateWorldMatrix(false, true);
  }
  private solveLeg(side: string, target: Vector3, rootRotation?: Quaternion, kneeDirection?: Vector3) {
    const hip = this.joints.get(`${side}_hip`)!.bone;
    const knee = this.joints.get(`${side}_knee`)!.bone;
    const ankleRef = this.joints.get(`${side}_ankle`)!;
    const ankle = ankleRef.bone;
    const h = hip.getWorldPosition(v()),
      k = knee.getWorldPosition(v()),
      a = ankle.getWorldPosition(v());
    const upper = h.distanceTo(k),
      lower = k.distanceTo(a);
    const direction = target.clone().sub(h);
    const distance = MathUtils.clamp(
      direction.length(),
      Math.abs(upper - lower) + 0.0001,
      upper + lower - 0.0001,
    );
    direction.normalize();
    const along =
      (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along));
    // The pole sets the knee's bend plane without moving the planted foot.
    // Existing motions retain the forward-facing default; new dances can turn
    // the knees outward independently of the contact trajectory.
    const pole = kneeDirection?.clone() ?? new Vector3(0, 0, 1);
    if (pole.lengthSq() < 1e-12) pole.set(0, 0, 1);
    if (rootRotation) pole.applyQuaternion(rootRotation);
    pole.addScaledVector(direction, -pole.dot(direction));
    if (pole.lengthSq() < 1e-12) {
      pole.set(0, 0, 1);
      if (Math.abs(pole.dot(direction)) > 0.9) pole.set(1, 0, 0);
      pole.addScaledVector(direction, -pole.dot(direction));
    }
    pole.normalize();
    const kneeTarget = h
      .clone()
      .addScaledVector(direction, along)
      .addScaledVector(pole, height);
    this.rotateToward(hip, knee, kneeTarget);
    this.rotateToward(knee, ankle, target);
    const footOrientation = ankleRef.world.clone();
    if (rootRotation) footOrientation.premultiply(rootRotation);
    ankle.quaternion.copy(
      ankle.parent!.getWorldQuaternion(q()).invert().multiply(footOrientation),
    );
    ankle.updateWorldMatrix(false, true);
  }
  snapshot() {
    return Object.fromEntries(
      [...this.joints].map(([id, ref]) => [
        id,
        {
          position: ref.bone.getWorldPosition(v()).toArray(),
          quaternion: ref.bone.quaternion.toArray(),
        },
      ]),
    );
  }
}
