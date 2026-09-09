import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { Bone } from "three";

/** A small x-ray accent marks the selected joint without exposing the whole rig. */
export class JointSelection extends Group {
  private sphere = new SphereGeometry(1, 16, 12);
  private cylinder = new CylinderGeometry(1, 1, 1, 8);
  private material = new MeshBasicMaterial({
    color: "#c4b5fd",
    transparent: true,
    opacity: 0.78,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private haloMaterial = this.material.clone();
  private selected: { bone: Bone; marker: Group; accent: Mesh | null }[] = [];
  private origin = new Vector3();
  private endpoint = new Vector3();
  private direction = new Vector3();
  private cylinderAxis = new Vector3(0, 1, 0);

  constructor(
    joints: ReadonlyMap<string, { bone: Bone }>,
    targets: readonly string[],
  ) {
    super();
    this.name = "selected-joints";
    this.haloMaterial.opacity = 0.12;
    for (const target of new Set(targets)) {
      const bone = joints.get(target)?.bone;
      if (!bone) continue;
      const finger = /_(thumb|index|middle|ring|pinky)_/.test(target);
      const radius = finger ? 0.0045 : 0.013;
      const marker = new Group();
      marker.name = `selected.${target}`;
      marker.userData.target = target;
      const dot = new Mesh(this.sphere, this.material);
      dot.scale.setScalar(radius);
      dot.renderOrder = 21;
      const halo = new Mesh(this.sphere, this.haloMaterial);
      halo.scale.setScalar(radius * 1.8);
      halo.renderOrder = 20;
      marker.add(halo, dot);
      const child = bone.children.find((node) => "isBone" in node);
      const accent = child ? new Mesh(this.cylinder, this.material) : null;
      if (accent) {
        accent.scale.set(finger ? 0.0014 : 0.0025, 1, finger ? 0.0014 : 0.0025);
        accent.renderOrder = 21;
        marker.add(accent);
      }
      this.add(marker);
      this.selected.push({ bone, marker, accent });
    }
    this.update();
  }

  update() {
    for (const { bone, marker, accent } of this.selected) {
      bone.getWorldPosition(this.origin);
      marker.position.copy(this.origin);
      if (!accent) continue;
      const child = bone.children.find((node) => "isBone" in node)!;
      child.getWorldPosition(this.endpoint);
      this.direction.copy(this.endpoint).sub(this.origin);
      const length = Math.min(this.direction.length() * 0.55, 0.065);
      accent.visible = length > 0.0001;
      if (!accent.visible) continue;
      this.direction.normalize();
      accent.scale.y = length;
      accent.position.copy(this.direction).multiplyScalar(length / 2);
      accent.quaternion.setFromUnitVectors(this.cylinderAxis, this.direction);
    }
    this.updateMatrixWorld(true);
  }

  release() {
    this.sphere.dispose();
    this.cylinder.dispose();
    this.material.dispose();
    this.haloMaterial.dispose();
  }

  snapshot() {
    return this.selected.map(({ marker }) => ({
      target: marker.userData.target as string,
      position: marker.getWorldPosition(new Vector3()).toArray(),
    }));
  }
}
