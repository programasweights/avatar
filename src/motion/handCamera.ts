import { MathUtils, Quaternion, Vector3 } from "three";
import type { Bone } from "three";

/** A hand-relative camera built only from the palm's stable attachment points. */
export function frameHand(
  joints: ReadonlyMap<string, { bone: Bone }>,
  side: "left" | "right",
  dorsal = false,
): { position: Vector3; target: Vector3; up: Vector3 } {
  const positionOf = (joint: string) => {
    const reference = joints.get(`${side}_${joint}`);
    if (!reference)
      throw new Error(`Cannot frame the hand: missing ${side}_${joint}.`);
    return reference.bone.getWorldPosition(new Vector3());
  };
  const wrist = positionOf("wrist");
  const middle = positionOf("middle_1");
  const index = positionOf("index_1");
  const pinky = positionOf("pinky_1");
  const along = middle.clone().sub(wrist);
  const palmLength = along.length();
  if (palmLength < 1e-5)
    throw new Error("Cannot frame a hand with a zero-length palm.");
  along.divideScalar(palmLength);
  const across = index.sub(pinky).projectOnPlane(along);
  if (across.lengthSq() < 1e-10)
    throw new Error("Cannot frame a hand with coincident knuckles.");
  across.normalize();

  // Mirrored rigs need opposite cross-product signs. The dorsal direction is
  // also the surface normal used by the coin's knuckle-transfer frame. Neither
  // the middle finger's rotation nor its animated tip can roll this camera.
  const normal = along
    .clone()
    .cross(across)
    .normalize()
    .multiplyScalar(side === "left" ? 1 : -1);
  if (dorsal) normal.negate();
  const scale = MathUtils.clamp(palmLength / 0.12, 0.8, 1.4);
  const target = wrist
    .clone()
    .addScaledVector(along, 0.13 * scale)
    .addScaledVector(across, 0.006 * scale);
  // A slight thumb-side angle exposes fingertip contact and curled segments;
  // the coin view is closer to face-on so its path stays unobscured.
  const offset = normal
    .multiplyScalar(0.56 * scale)
    .addScaledVector(across, (dorsal ? 0.045 : 0.1) * scale)
    .addScaledVector(along, 0.035 * scale);
  const position = target.clone().add(offset);
  const up = along
    .clone()
    .projectOnPlane(offset.clone().normalize())
    .normalize();
  return { position, target, up };
}

/** Follow an authored orbit without interpolating the camera through the hand. */
export function frameHandOrbit(
  joints: ReadonlyMap<string, { bone: Bone }>,
  side: "left" | "right",
  degrees: number,
) {
  const palm = frameHand(joints, side),
    back = frameHand(joints, side, true);
  const t = MathUtils.clamp(degrees / 180, 0, 1);
  if (t === 0) return palm;
  if (t === 1) return back;
  const a = palm.position.clone().sub(palm.target),
    b = back.position.clone().sub(back.target);
  const radius = MathUtils.lerp(a.length(), b.length(), t);
  const turn = new Quaternion().setFromUnitVectors(
    a.clone().normalize(),
    b.clone().normalize(),
  );
  const direction = a
    .normalize()
    .applyQuaternion(new Quaternion().slerp(turn, t));
  const target = palm.target.clone().lerp(back.target, t);
  // Recover the stable palm axis, rather than interpolating projected up
  // vectors that can cancel during a half orbit.
  const wrist = joints
    .get(`${side}_wrist`)!
    .bone.getWorldPosition(new Vector3());
  const up = joints
    .get(`${side}_middle_1`)!
    .bone.getWorldPosition(new Vector3())
    .sub(wrist)
    .projectOnPlane(direction)
    .normalize();
  return {
    position: target.clone().addScaledVector(direction, radius),
    target,
    up,
  };
}
