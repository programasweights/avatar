import { Bone, Matrix4, Object3D, Quaternion, Vector3 } from "three";

const body = {
  hips: "pelvis",
  spine: "spine_01",
  spine_mid: "spine_02",
  chest: "spine_03",
  neck: "neck_01",
  head: "Head",
};
const limbs = {
  clavicle: "clavicle",
  shoulder: "upperarm",
  elbow: "lowerarm",
  wrist: "hand",
  hip: "thigh",
  knee: "calf",
  ankle: "foot",
  toes: "ball",
};
const mixamoBody = {
  hips: "Hips",
  spine: "Spine",
  spine_mid: "Spine1",
  chest: "Spine2",
  neck: "Neck",
  head: "Head",
};
const mixamoLimbs = {
  clavicle: "Shoulder",
  shoulder: "Arm",
  elbow: "ForeArm",
  wrist: "Hand",
  hip: "UpLeg",
  knee: "Leg",
  ankle: "Foot",
  toes: "ToeBase",
};

export const JOINTS: Record<string, string> = { ...body };
const MIXAMO: Record<string, string> = { ...mixamoBody };
for (const side of ["left", "right"]) {
  const suffix = side === "left" ? "l" : "r";
  const title = side[0].toUpperCase() + side.slice(1);
  for (const [joint, bone] of Object.entries(limbs)) {
    JOINTS[`${side}_${joint}`] = `${bone}_${suffix}`;
    MIXAMO[`${side}_${joint}`] =
      title + mixamoLimbs[joint as keyof typeof mixamoLimbs];
  }
  for (const finger of ["thumb", "index", "middle", "ring", "pinky"])
    for (const segment of [1, 2, 3]) {
      JOINTS[`${side}_${finger}_${segment}`] =
        `${finger}_0${segment}_${suffix}`;
      MIXAMO[`${side}_${finger}_${segment}`] =
        `${title}Hand${finger[0].toUpperCase() + finger.slice(1)}${segment}`;
    }
}

export function identifyRig(scene: Object3D) {
  const bones = new Map<string, Bone>();
  scene.traverse((object) => {
    if ((object as Bone).isBone)
      bones.set(object.name.replace(/^mixamorig:?/, ""), object as Bone);
  });
  const imported = !bones.has("pelvis") && bones.has("Hips");
  const names = imported ? MIXAMO : JOINTS;
  const joints = new Map<string, Bone>();
  for (const [id, name] of Object.entries(names)) {
    const bone = bones.get(name);
    if (!bone) throw new Error(`Missing joint: ${id} (${name})`);
    joints.set(id, bone);
  }
  return { joints, imported };
}

/** Establish our standing reference from the CC0 character's original T-pose. */
export function standNaturally(joints: Map<string, Bone>) {
  for (const side of ["left", "right"]) {
    const direction = new Vector3(
      side === "left" ? 0.04 : -0.04,
      -1,
      0,
    ).normalize();
    for (const [joint, child] of [
      ["shoulder", "elbow"],
      ["elbow", "wrist"],
    ]) {
      const bone = joints.get(`${side}_${joint}`)!;
      const from = joints
        .get(`${side}_${child}`)!
        .getWorldPosition(new Vector3())
        .sub(bone.getWorldPosition(new Vector3()))
        .normalize();
      const world = new Quaternion()
        .setFromUnitVectors(from, direction)
        .multiply(bone.getWorldQuaternion(new Quaternion()));
      bone.quaternion.copy(
        bone
          .parent!.getWorldQuaternion(new Quaternion())
          .invert()
          .multiply(world),
      );
      bone.updateWorldMatrix(false, true);
    }
  }
}

/** Map finger control axes to anatomy so Z always curls toward the palm. */
export function fingerBasis(joints: Map<string, Bone>, id: string): Quaternion {
  if (!/_(thumb|index|middle|ring|pinky)_/.test(id)) return new Quaternion();
  const side = id.startsWith("left") ? "left" : "right";
  const position = (name: string) =>
    joints.get(`${side}_${name}`)!.getWorldPosition(new Vector3());
  const along = position("middle_1").sub(position("wrist")).normalize();
  const across = position("index_1").sub(position("pinky_1")).normalize();
  const normal = along
    .clone()
    .cross(across)
    .normalize()
    .multiplyScalar(side === "left" ? 1 : -1);
  const bone = joints.get(id)!;
  const end = bone.children.find((child) => (child as Bone).isBone);
  if (!end) throw new Error(`Missing fingertip: ${id}`);
  const y = end
    .getWorldPosition(new Vector3())
    .sub(bone.getWorldPosition(new Vector3()))
    .normalize();
  const z = y
    .clone()
    .cross(normal)
    .normalize()
    .multiplyScalar(side === "left" ? 1 : -1);
  const x = y.clone().cross(z).normalize();
  const inverse = bone.getWorldQuaternion(new Quaternion()).invert();
  return new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(
      x.applyQuaternion(inverse),
      y.applyQuaternion(inverse),
      z.applyQuaternion(inverse),
    ),
  );
}
