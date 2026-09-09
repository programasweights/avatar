import { Bone, Euler, MathUtils, Quaternion, Vector3 } from "three";
import type { ContactValue } from "./types";
type Joints = ReadonlyMap<
  string,
  { bone: Bone; rotation: Quaternion; basis: Quaternion }
>;
export function fingertip(joints: Joints, id: string): Bone {
  const third = joints.get(id.replace("_tip", "_3"))?.bone;
  const tip = third?.children.find((child) => (child as Bone).isBone) as
    | Bone
    | undefined;
  if (!tip) throw new Error(`Missing fingertip: ${id}`);
  return tip;
}
// Deterministic CCD on the actual finger chain. Each sample starts from the
// authored pose; the contact weight blends back to that pose on release.
export function solveContacts(joints: Joints, contacts: ContactValue[]) {
  for (const c of contacts) {
    if (c.mode !== "fingertips" || c.weight <= 0) continue;
    const prefix = c.effector.replace("_tip", "");
    const chain = [1, 2, 3].map((n) => joints.get(`${prefix}_${n}`)!);
    const tip = fingertip(joints, c.effector),
      target = fingertip(joints, c.target).getWorldPosition(new Vector3());
    const before = chain.map((ref) => ref.bone.quaternion.clone());
    for (let iteration = 0; iteration < 80; iteration++) {
      if (tip.getWorldPosition(new Vector3()).distanceTo(target) < 0.0003)
        break;
      for (let index = 2; index >= 0; index--) {
        const ref = chain[index],
          bone = ref.bone;
        // Thumb base has opposition axes; distal joints primarily curl.
        for (const axisName of index === 0 ? ["z", "x", "y"] : ["z"]) {
          const axis = new Vector3(
            axisName === "x" ? 1 : 0,
            axisName === "y" ? 1 : 0,
            axisName === "z" ? 1 : 0,
          )
            .applyQuaternion(ref.basis)
            .applyQuaternion(bone.getWorldQuaternion(new Quaternion()));
          const origin = bone.getWorldPosition(new Vector3());
          const from = tip
            .getWorldPosition(new Vector3())
            .sub(origin)
            .projectOnPlane(axis)
            .normalize();
          const to = target
            .clone()
            .sub(origin)
            .projectOnPlane(axis)
            .normalize();
          if (from.lengthSq() < 0.1 || to.lengthSq() < 0.1) continue;
          const angle = MathUtils.clamp(
            Math.atan2(axis.dot(from.clone().cross(to)), from.dot(to)),
            -0.3,
            0.3,
          );
          const localAxis = new Vector3(
            axisName === "x" ? 1 : 0,
            axisName === "y" ? 1 : 0,
            axisName === "z" ? 1 : 0,
          ).applyQuaternion(ref.basis);
          bone.quaternion.multiply(
            new Quaternion().setFromAxisAngle(localAxis, angle),
          );
          const e = new Euler().setFromQuaternion(
            ref.basis
              .clone()
              .invert()
              .multiply(ref.rotation.clone().invert())
              .multiply(bone.quaternion)
              .multiply(ref.basis),
            "XYZ",
          );
          e.x = MathUtils.clamp(
            e.x,
            index === 0 ? -1.6 : -0.15,
            index === 0 ? 1.6 : 0.15,
          );
          e.y = MathUtils.clamp(
            e.y,
            index === 0 ? -1.6 : -0.15,
            index === 0 ? 1.6 : 0.15,
          );
          e.z = MathUtils.clamp(e.z, -2, 2);
          bone.quaternion
            .copy(ref.rotation)
            .multiply(ref.basis)
            .multiply(new Quaternion().setFromEuler(e))
            .multiply(ref.basis.clone().invert());
          bone.updateWorldMatrix(false, true);
        }
      }
    }
    chain.forEach((ref, i) =>
      ref.bone.quaternion.copy(before[i].slerp(ref.bone.quaternion, c.weight)),
    );
    chain[0].bone.updateWorldMatrix(false, true);
  }
}
