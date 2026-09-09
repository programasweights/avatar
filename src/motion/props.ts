import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  TorusGeometry,
  Vector3,
  Euler,
  MathUtils,
} from "three";
import type { Bone } from "three";
import type { ContactValue, MotionProp, PoseValue } from "./types";
export function createCoin(radius: number, thickness: number): Group {
  const group = new Group();
  group.name = "Procedural coin";
  const gold = new MeshStandardMaterial({
    color: "#d9aa41",
    metalness: 0.82,
    roughness: 0.26,
  });
  const rim = new MeshStandardMaterial({
    color: "#ffdc78",
    metalness: 0.85,
    roughness: 0.2,
  });
  group.add(
    new Mesh(new CylinderGeometry(radius, radius, thickness, 64), gold),
  );
  for (const side of [-1, 1]) {
    const ring = new Mesh(
      new TorusGeometry(radius * 0.85, radius * 0.025, 8, 64),
      rim,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = side * thickness * 0.54;
    group.add(ring);
    const bar = new Mesh(
      new BoxGeometry(radius * 0.12, thickness * 0.16, radius * 0.85),
      rim,
    );
    bar.position.y = side * thickness * 0.57;
    group.add(bar);
    const cap = new Mesh(
      new BoxGeometry(radius * 0.45, thickness * 0.16, radius * 0.1),
      rim,
    );
    cap.position.set(0, side * thickness * 0.57, radius * 0.4);
    group.add(cap);
  }
  group.traverse((o) => {
    if (o instanceof Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}
export class RigProps {
  private objects = new Map<string, { definition: string; object: Group }>();
  private parent: Object3D;
  private joints: ReadonlyMap<string, { bone: Bone }>;
  constructor(parent: Object3D, joints: ReadonlyMap<string, { bone: Bone }>) {
    this.parent = parent;
    this.joints = joints;
  }
  apply(
    definitions: MotionProp[],
    contacts: ContactValue[],
    values: PoseValue[],
  ) {
    const live = new Set(definitions.map((p) => p.id));
    for (const [id, item] of this.objects)
      if (!live.has(id)) {
        this.disposeObject(item.object);
        this.objects.delete(id);
      }
    for (const prop of definitions) {
      let item = this.objects.get(prop.id);
      const definition = JSON.stringify(prop);
      if (item?.definition !== definition) {
        if (item) this.disposeObject(item.object);
        item = { definition, object: createCoin(prop.radius, prop.thickness) };
        this.objects.set(prop.id, item);
        this.parent.add(item.object);
      }
      const c = contacts.find(
        (c): c is Extract<ContactValue, { mode: "prop_transfer" }> =>
          c.mode === "prop_transfer" && c.prop === prop.id,
      );
      const opacity = MathUtils.clamp(c?.visibility ?? 1, 0, 1);
      item.object.visible = !!c && opacity > 0;
      item.object.userData.opacity = c ? opacity : 0;
      if (!c) {
        item.object.position.set(0, 0, 0);
        item.object.quaternion.identity();
        item.object.updateWorldMatrix(false, true);
        continue;
      }
      item.object.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          const transparent = opacity < 1;
          if (material.transparent !== transparent) {
            material.transparent = transparent;
            material.needsUpdate = true;
          }
          material.opacity = opacity;
          material.depthWrite = !transparent;
        }
      });
      const side = c.from.split("_")[0];
      const a = this.joints.get(c.from)!.bone.getWorldPosition(new Vector3());
      const b = this.joints.get(c.to)!.bone.getWorldPosition(new Vector3());
      const index = this.joints
        .get(`${side}_index_1`)!
        .bone.getWorldPosition(new Vector3());
      const pinky = this.joints
        .get(`${side}_pinky_1`)!
        .bone.getWorldPosition(new Vector3());
      const knuckle = this.joints
        .get(`${side}_middle_1`)!
        .bone.getWorldPosition(new Vector3());
      const next = this.joints
        .get(`${side}_middle_2`)!
        .bone.getWorldPosition(new Vector3());
      const across = pinky.sub(index).normalize();
      const along = next.sub(knuckle).normalize();
      const normal = along
        .clone()
        .cross(across)
        .normalize()
        .multiplyScalar(side === "left" ? 1 : -1);
      const z = across.clone().cross(normal).normalize();
      const basis = new Matrix4().makeBasis(across, normal, z);
      // Both values are half-turns. An explicit starting phase preserves the coin's
      // marked face through adjacent handoffs and stays deterministic when scrubbed.
      const angle = Math.PI * ((c.rollOffset ?? 0) + c.progress * c.rolls);
      const height =
        0.02 +
        prop.radius * Math.abs(Math.sin(angle)) +
        prop.thickness * 0.5 * Math.abs(Math.cos(angle));
      const world = a.lerp(b, c.progress).addScaledVector(normal, height);
      const rotation = new Quaternion()
        .setFromRotationMatrix(basis)
        .multiply(
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -angle),
        );
      const offsets = new Vector3(),
        degrees = new Vector3();
      values
        .filter((v) => v.target === prop.id)
        .forEach(
          (v) =>
            ((v.channel === "position" ? offsets : degrees)[v.axis] = v.value),
        );
      world.add(
        offsets.applyQuaternion(new Quaternion().setFromRotationMatrix(basis)),
      );
      rotation.multiply(
        new Quaternion().setFromEuler(
          new Euler(
            ...(degrees.toArray().map(MathUtils.degToRad) as [
              number,
              number,
              number,
            ]),
          ),
        ),
      );
      this.parent.updateWorldMatrix(true, false);
      item.object.position.copy(this.parent.worldToLocal(world));
      item.object.quaternion.copy(
        this.parent
          .getWorldQuaternion(new Quaternion())
          .invert()
          .multiply(rotation),
      );
      const parentScale = this.parent.getWorldScale(new Vector3());
      item.object.scale.set(
        1 / parentScale.x,
        1 / parentScale.y,
        1 / parentScale.z,
      );
      item.object.updateWorldMatrix(false, true);
    }
  }
  snapshot() {
    return Object.fromEntries(
      [...this.objects].map(([id, { object }]) => [
        id,
        {
          visible: object.visible,
          opacity: object.userData.opacity ?? 1,
          position: object.getWorldPosition(new Vector3()).toArray(),
          quaternion: object.getWorldQuaternion(new Quaternion()).toArray(),
        },
      ]),
    );
  }
  private disposeObject(object: Group) {
    object.removeFromParent();
    object.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) =>
          m.dispose(),
        );
      }
    });
  }
  dispose() {
    this.objects.forEach((item) => this.disposeObject(item.object));
    this.objects.clear();
  }
}
