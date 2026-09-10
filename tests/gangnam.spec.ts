import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createGangnam, changeGangnamSupport } from "../src/motion/gangnam";
import {
  createDance,
  changeTempo,
  jointOffset,
  replaceArms,
} from "../src/motion/skills";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { validateRigProgram } from "../src/motion/director";
import type { MotionProgram, Timeline } from "../src/motion/types";

let rig: MotionRig;
test.beforeAll(async () => {
  const bytes = await readFile(
    new URL("../public/assets/character.glb", import.meta.url),
  );
  const jsonLength = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  delete asset.images;
  delete asset.textures;
  delete asset.samplers;
  asset.materials = [];
  for (const mesh of asset.meshes)
    for (const primitive of mesh.primitives) delete primitive.material;
  const serialized = Buffer.from(JSON.stringify(asset));
  const json = Buffer.concat([
    serialized,
    Buffer.alloc((4 - (serialized.length % 4)) % 4, 32),
  ]);
  const binary = bytes.subarray(20 + jsonLength),
    header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const gltf = await new GLTFLoader().parseAsync(
    Uint8Array.from(Buffer.concat([header, json, binary])).buffer,
    "",
  );
  rig = new MotionRig(gltf.scene, gltf.animations);
});
test.afterAll(() => rig?.props.dispose());
const pose = (timeline: Timeline, time: number) => {
  rig.apply(sampleTimeline(timeline, time));
  return rig.snapshot();
};
const distance = (a: number[], b: number[]) =>
  Math.hypot(...a.map((v, i) => v - b[i]));

// These use the shipped skeleton: a valid-looking curve is insufficient if the
// actual leg IK slides its planted foot or a wrist rotation hides the gesture.
test("Gangnam choreography closes at every joint and stays finite at all support settings", () => {
  for (const support of ["both", "left", "right"] as const) {
    const program = createGangnam({ support }),
      timeline = validateRigProgram(program);
    expect(timeline.duration).toBeCloseTo((16 * 60) / 132, 8);
    expect(program.dance).toEqual({ style: "gangnam", support });
    const first = pose(timeline, 0),
      last = pose(timeline, timeline.duration);
    for (const joint of Object.keys(first)) {
      expect(
        distance(first[joint].position, last[joint].position),
        joint,
      ).toBeLessThan(1e-6);
      expect(
        distance(first[joint].quaternion, last[joint].quaternion),
        joint,
      ).toBeLessThan(1e-6);
    }
    for (let frame = 0; frame <= 144; frame++) {
      const sample = pose(timeline, (timeline.duration * frame) / 144);
      expect(
        Object.values(sample)
          .flatMap((v) => [...v.position, ...v.quaternion])
          .every(Number.isFinite),
      ).toBe(true);
      for (const side of ["left", "right"])
        expect(sample[`${side}_toes`].position[1]).toBeGreaterThan(0.01);
    }
  }
});

test("riding footwork follows its alternating and double-step rhythm with planted contacts", () => {
  rig.apply([]);
  const rest = rig.snapshot(),
    timeline = compileMotion(createGangnam());
  const order = [
    "right",
    "left",
    "right",
    "right",
    "left",
    "right",
    "left",
    "left",
  ];
  for (let beat = 0; beat < 16; beat++) {
    const free = order[beat % 8],
      support = free === "left" ? "right" : "left";
    const apex = pose(timeline, ((beat + 0.48) * 60) / 132);
    expect(
      apex[`${free}_ankle`].position[1] - rest[`${free}_ankle`].position[1],
    ).toBeGreaterThan(0.225);
    expect(
      (free === "left" ? 1 : -1) *
        (apex[`${free}_knee`].position[0] - apex[`${free}_ankle`].position[0]),
    ).toBeGreaterThan(0.04);
    expect(
      apex[`${support}_ankle`].position[1] -
        rest[`${support}_ankle`].position[1],
    ).toBeLessThan(0.037);
    for (const phase of [0.01, 0.09, 0.9, 0.99]) {
      const contact = pose(timeline, ((beat + phase) * 60) / 132);
      for (const side of ["left", "right"]) {
        expect(contact[`${side}_ankle`].position[1]).toBeCloseTo(
          rest[`${side}_ankle`].position[1],
          4,
        );
        expect(contact[`${side}_ankle`].position[0]).toBeCloseTo(
          rest[`${side}_ankle`].position[0] + (side === "left" ? 0.06 : -0.06),
          4,
        );
        expect(contact[`${side}_ankle`].position[2]).toBeCloseTo(
          rest[`${side}_ankle`].position[2],
          4,
        );
      }
    }
  }
});

test("single-foot version visibly tucks the other leg throughout the dance and balances over support", () => {
  rig.apply([]);
  const rest = rig.snapshot();
  for (const support of ["left", "right"] as const) {
    const free = support === "left" ? "right" : "left",
      timeline = compileMotion(createGangnam({ support }));
    for (let frame = 0; frame <= 160; frame++) {
      const sample = pose(timeline, (timeline.duration * frame) / 160);
      expect(
        sample[`${free}_ankle`].position[1] - rest[`${free}_ankle`].position[1],
      ).toBeGreaterThan(0.379);
      expect(
        sample[`${support}_ankle`].position[1] -
          rest[`${support}_ankle`].position[1],
      ).toBeLessThan(0.036);
      expect(
        Math.abs(
          sample.hips.position[0] - sample[`${support}_ankle`].position[0],
        ),
      ).toBeLessThan(0.04);
    }
  }
});

test("reins present two forward-facing fists, then the raised fist circles above the head", () => {
  const timeline = compileMotion(createGangnam());
  for (const beat of [0, 2, 4, 6]) {
    const s = pose(timeline, (beat * 60) / 132);
    expect(s.left_wrist.position[0]).toBeLessThan(s.right_wrist.position[0]);
    expect(
      distance(s.left_wrist.position, s.right_wrist.position),
    ).toBeLessThan(0.09);
    for (const side of ["left", "right"]) {
      // The fists project toward the audience, not sideways into a forearm.
      const hand = s[`${side}_middle_1`].position.map(
        (v, i) => v - s[`${side}_wrist`].position[i],
      );
      expect(hand[2]).toBeGreaterThan(0.075);
      expect(Math.abs(hand[0])).toBeLessThan(0.03);
    }
  }
  const orbit: number[][] = [];
  for (const beat of [10, 10.5, 11, 11.5]) {
    const s = pose(timeline, (beat * 60) / 132);
    expect(s.right_wrist.position[1] - s.head.position[1]).toBeGreaterThan(
      0.12,
    );
    orbit.push(s.right_wrist.position);
    for (const side of ["left", "right"]) {
      const tip = rig.joints
        .get(`${side}_thumb_3`)!
        .bone.children[0].getWorldPosition(new Vector3())
        .toArray();
      const grip = s[`${side}_index_2`].position.map(
        (v, i) => (v + s[`${side}_middle_2`].position[i]) / 2,
      );
      expect(distance(tip, grip)).toBeLessThan(0.012);
    }
  }
  expect(
    Math.max(...orbit.map((v) => v[0])) - Math.min(...orbit.map((v) => v[0])),
  ).toBeGreaterThan(0.08);
  expect(
    Math.max(...orbit.map((v) => v[2])) - Math.min(...orbit.map((v) => v[2])),
  ).toBeGreaterThan(0.07);
});

test("support edits preserve upper-body edits, tempo and input immutability", () => {
  const original = jointOffset(
    changeTempo(createGangnam(), 96),
    "left_index_1",
    "z",
    20,
  );
  const before = JSON.stringify(original);
  const changed = changeGangnamSupport(original, "left");
  for (const id of ["arms", "details", "torso.groove"])
    expect(findNode(changed.root, id)).toEqual(findNode(original.root, id));
  expect(changed.bpm).toBe(96);
  expect(compileMotion(changed).duration).toBe(
    compileMotion(original).duration,
  );
  expect(JSON.stringify(original)).toBe(before);
  expect(changeGangnamSupport(changed, "other").dance?.support).toBe("right");
  expect(
    changeGangnamSupport(changeGangnamSupport(changed, "both"), "other").dance
      ?.support,
  ).toBe("left");
  expect(() => changeGangnamSupport(createDance("salsa"), "left")).toThrow(
    "Gangnam",
  );
  expect(() => createGangnam({ bpm: NaN })).toThrow("tempo");
  expect(() => createGangnam({ support: "neither" as never })).toThrow(
    "support",
  );
  expect(() =>
    changeGangnamSupport(
      {
        ...original,
        root: { id: "empty", label: "Empty", kind: "parallel", children: [] },
      } as MotionProgram,
      "left",
    ),
  ).toThrow("branches");
});

test("dance integration and independent arm edits retain the complete foot choreography", () => {
  const dance = createDance("gangnam");
  expect(dance.bpm).toBe(132);
  expect(dance).toEqual(createGangnam());
  const still = replaceArms(dance, "still");
  expect(findNode(still.root, "feet")).toEqual(findNode(dance.root, "feet"));
  expect(findNode(still.root, "balance")).toEqual(
    findNode(dance.root, "balance"),
  );
  expect(compileMotion(still).duration).toBe(compileMotion(dance).duration);
});

test("explicit knee directions preserve old forward IK and planted ankle targets", () => {
  const timeline = compileMotion(createDance("salsa"));
  const directions = (side: string, vector: number[]) =>
    vector.map((value, axis) => ({
      target: `${side}_knee_pole`,
      channel: "position" as const,
      axis: (["x", "y", "z"] as const)[axis],
      value,
    }));
  for (const progress of [0.1, 0.4, 0.7]) {
    const values = sampleTimeline(timeline, timeline.duration * progress);
    rig.apply(values);
    const original = rig.snapshot();
    for (const supplied of [
      [0, 0, 1],
      [0, 0, 0],
    ]) {
      rig.apply([
        ...values,
        ...directions("left", supplied),
        ...directions("right", supplied),
      ]);
      const explicit = rig.snapshot();
      for (const joint of [
        "left_knee",
        "right_knee",
        "left_ankle",
        "right_ankle",
      ])
        expect(
          distance(explicit[joint].position, original[joint].position),
        ).toBeLessThan(1e-7);
    }
    rig.apply([
      ...values,
      ...directions("left", [1, 0, 0.2]),
      ...directions("right", [-1, 0, 0.2]),
    ]);
    const outward = rig.snapshot();
    expect(
      outward.left_knee.position[0] - original.left_knee.position[0],
    ).toBeGreaterThan(0.04);
    expect(
      original.right_knee.position[0] - outward.right_knee.position[0],
    ).toBeGreaterThan(0.04);
    for (const side of ["left", "right"])
      expect(
        distance(
          outward[`${side}_ankle`].position,
          original[`${side}_ankle`].position,
        ),
      ).toBeLessThan(1e-5);
    const parallel = ["left", "right"].flatMap((side) =>
      directions(
        side,
        original[`${side}_ankle`].position.map(
          (v, i) => v - original[`${side}_hip`].position[i],
        ),
      ),
    );
    rig.apply([...values, ...parallel]);
    const degenerate = rig.snapshot();
    expect(
      Object.values(degenerate)
        .flatMap((v) => [...v.position, ...v.quaternion])
        .every(Number.isFinite),
    ).toBe(true);
    for (const side of ["left", "right"])
      expect(
        distance(
          degenerate[`${side}_ankle`].position,
          original[`${side}_ankle`].position,
        ),
      ).toBeLessThan(1e-5);
  }
});
