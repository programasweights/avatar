import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fingertip } from "../src/motion/contacts";
import {
  createCoinRoll,
  createFingertipTouches,
} from "../src/motion/dexterityDirector";
import { createFingerRipple } from "../src/motion/dexterity";
import { validateRigProgram } from "../src/motion/director";
import {
  activeNodes,
  compileMotion,
  sampleContacts,
  sampleTimeline,
} from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { motionHandFrame } from "../src/motion/MotionStage";
import { changeTempo, createDance, jointOffset } from "../src/motion/skills";
import type { ContactNode, MotionProgram, Timeline } from "../src/motion/types";

// Load the actual character and idle animation in Node. Images/materials are
// omitted to avoid requiring a browser image decoder; skeleton, meshes, skin
// weights, animation accessors, and the entire binary chunk remain unchanged.
async function loadActualRig(): Promise<MotionRig> {
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
  const binary = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const packed = Uint8Array.from(Buffer.concat([header, json, binary])).buffer;
  const gltf = await new GLTFLoader().parseAsync(packed, "");
  return new MotionRig(gltf.scene, gltf.animations);
}

let rig: MotionRig;
test.beforeAll(async () => {
  rig = await loadActualRig();
});
test.afterAll(() => {
  rig?.props.dispose();
});

function apply(timeline: Timeline, time: number) {
  rig.apply(
    sampleTimeline(timeline, time),
    sampleContacts(timeline, time),
    timeline.props ?? [],
  );
}

test("actual rig holds thumb contact within 3 mm of every fingertip on both hands in either order", () => {
  test.setTimeout(90_000);
  const measured: {
    side: string;
    reverse: boolean;
    target: string;
    progress: number;
    errorMm: number;
  }[] = [];
  for (const side of ["left", "right"] as const) {
    for (const reverse of [false, true]) {
      const timeline = validateRigProgram(
        createFingertipTouches(side, reverse),
      );
      const contacts = timeline.contacts ?? [];
      expect(contacts).toHaveLength(8);
      expect(
        new Set(
          contacts.flatMap((c) => (c.mode === "fingertips" ? [c.target] : [])),
        ).size,
      ).toBe(4);
      for (const track of contacts) {
        if (track.mode !== "fingertips")
          throw new Error("Expected a fingertip contact.");
        for (const progress of [0.3, 0.475, 0.65]) {
          const time = track.start + track.duration * progress;
          const active = sampleContacts(timeline, time);
          expect(active).toEqual([
            {
              mode: "fingertips",
              effector: track.effector,
              target: track.target,
              weight: 1,
            },
          ]);
          apply(timeline, time);
          const thumb = fingertip(rig.joints, track.effector).getWorldPosition(
            new Vector3(),
          );
          const target = fingertip(rig.joints, track.target).getWorldPosition(
            new Vector3(),
          );
          measured.push({
            side,
            reverse,
            target: track.target,
            progress,
            errorMm: thumb.distanceTo(target) * 1000,
          });
        }
      }
    }
  }
  const failures = measured.filter((result) => result.errorMm >= 3);
  expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  console.log(
    `Held contacts: ${measured.length}; maximum error ${Math.max(...measured.map((r) => r.errorMm)).toFixed(3)} mm.`,
  );
});

test("contacts survive nested repeats, sequencing, and tempo changes without overlap at boundaries", () => {
  test.setTimeout(60_000);
  const original = createFingertipTouches("right", true);
  const originalTimeline = compileMotion(original);
  const composed: MotionProgram = {
    ...original,
    root: {
      id: "contact_demo",
      label: "Wait, then repeat the hand study",
      kind: "sequence",
      children: [
        {
          id: "lead_in",
          label: "Brief pause",
          kind: "curve",
          target: "neck",
          axis: "x",
          channel: "rotation",
          duration: 0.5,
          curve: { kind: "constant", value: 0 },
        },
        {
          id: "study_twice",
          label: "Twice",
          kind: "repeat",
          count: 2,
          children: [original.root],
        },
      ],
    },
  };
  const timeline = validateRigProgram(composed);
  const slowed = validateRigProgram(changeTempo(composed, 72));
  const scale = composed.bpm / 72;
  expect(timeline.contacts).toHaveLength(16);
  expect(slowed.duration).toBeCloseTo(timeline.duration * scale, 10);
  expect(sampleContacts(timeline, 0.25)).toEqual([]);
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const track of originalTimeline.contacts ?? []) {
      const sourceTime = track.start + track.duration * 0.5;
      const time = 0.5 + repeat * originalTimeline.duration + sourceTime;
      const expected = sampleContacts(originalTimeline, sourceTime);
      expect(sampleContacts(timeline, time)).toEqual(expected);
      expect(sampleContacts(slowed, time * scale)).toEqual(expected);
      expect(activeNodes(timeline, time).has("study_twice")).toBe(true);
      apply(timeline, time);
      const normalPose = rig.snapshot();
      apply(slowed, time * scale);
      const slowPose = rig.snapshot();
      for (const target of Object.keys(normalPose)) {
        normalPose[target].position.forEach((v, i) =>
          expect(slowPose[target].position[i]).toBeCloseTo(v, 8),
        );
      }
    }
  }
  for (const track of timeline.contacts ?? []) {
    const boundary = track.start + track.duration;
    if (boundary >= timeline.duration) continue;
    expect(
      sampleContacts(timeline, boundary),
      `No overlap at ${boundary}`,
    ).toHaveLength(1);
  }
});

test("rejects malformed contacts, cross-hand anchors, foreign props, and rig-shadowing prop IDs", () => {
  const make = (root: ContactNode): MotionProgram => ({
    version: 2,
    title: "Invalid contact cases",
    bpm: 108,
    root,
  });
  const contact: ContactNode = {
    id: "contact",
    label: "Thumb contact",
    kind: "contact",
    mode: "fingertips",
    effector: "left_thumb_tip",
    target: "left_index_tip",
    duration: 1,
    weight: { kind: "constant", value: 1 },
  };
  for (const changes of [
    { target: "left_imaginary_tip" },
    { target: "right_index_tip" },
    { target: "left_index_3" },
    { target: "left_thumb_tip" },
    { effector: "foreign_thumb_tip" },
    { weight: { kind: "constant", value: NaN } },
  ])
    expect(() =>
      validateRigProgram(make({ ...contact, ...changes } as ContactNode)),
    ).toThrow();
  const transfer: ContactNode = {
    id: "transfer",
    label: "Coin transfer",
    kind: "contact",
    mode: "prop_transfer",
    prop: "coin",
    from: "left_index_2",
    to: "left_middle_2",
    duration: 1,
    progress: { kind: "constant", value: 0.5 },
  };
  const withProp = (root: ContactNode): MotionProgram => ({
    ...make(root),
    props: [{ id: "coin", kind: "coin", radius: 0.022, thickness: 0.003 }],
  });
  expect(() => validateRigProgram(make(transfer))).toThrow();
  for (const changes of [
    { from: "left_index_9" },
    { to: "right_middle_2" },
    { to: "left_thumb_2" },
    { prop: "foreign_coin" },
    { rolls: Infinity },
    { rollOffset: Infinity },
    { rollOffset: 65 },
  ])
    expect(() =>
      validateRigProgram(withProp({ ...transfer, ...changes } as ContactNode)),
    ).toThrow();
  const shadowed = withProp({ ...transfer, prop: "head" });
  shadowed.props![0].id = "head";
  expect(() => validateRigProgram(shadowed)).toThrow("shadow");
});

test("overlapping ownership is rejected for one thumb or coin while sequential handoffs remain valid", () => {
  const thumb: ContactNode = {
    id: "thumb_one",
    label: "Thumb meets index",
    kind: "contact",
    mode: "fingertips",
    effector: "left_thumb_tip",
    target: "left_index_tip",
    duration: 1,
    weight: { kind: "constant", value: 1 },
  };
  const otherThumb: ContactNode = {
    ...thumb,
    id: "thumb_two",
    target: "left_pinky_tip",
  };
  const coin: ContactNode = {
    id: "coin_one",
    label: "Coin on left hand",
    kind: "contact",
    mode: "prop_transfer",
    prop: "coin",
    from: "left_index_2",
    to: "left_middle_2",
    duration: 1,
    progress: { kind: "constant", value: 0.5 },
  };
  const otherCoin: ContactNode = {
    ...coin,
    id: "coin_two",
    from: "right_index_2",
    to: "right_middle_2",
  };
  for (const pair of [
    [thumb, otherThumb],
    [coin, otherCoin],
  ]) {
    const program: MotionProgram = {
      version: 2,
      title: "Conflicting ownership",
      bpm: 108,
      props: [{ id: "coin", kind: "coin", radius: 0.022, thickness: 0.003 }],
      root: {
        id: "contacts",
        label: "Contacts",
        kind: "parallel",
        children: pair,
      },
    };
    expect(() => validateRigProgram(program)).toThrow();
    if (program.root.kind !== "parallel")
      throw new Error("Expected a contact group.");
    program.root = { ...program.root, kind: "sequence" };
    const timeline = validateRigProgram(program);
    expect(sampleContacts(timeline, 1)).toHaveLength(1);
    expect(timeline.duration).toBe(2);
  }
});

test("Hanging-arm finger cameras stay outside the body and raised studies retain upright hand framing", () => {
  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    for (const style of ["idle", "salsa", "cha_cha"] as const) {
      const timeline = compileMotion(
        jointOffset(
          createDance(style),
          `${side}_index_1`,
          "z",
          sign * 65,
          true,
        ),
      );
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        apply(timeline, timeline.duration * fraction);
        const frame = motionHandFrame(rig.joints, timeline, side);
        expect((frame.position.x - frame.target.x) * sign).toBeCloseTo(0.3, 10);
        expect(frame.position.z - frame.target.z).toBeCloseTo(0.55, 10);
        expect(frame.up.toArray()).toEqual([0, 1, 0]);
      }
    }
    const timeline = compileMotion(createFingerRipple(side));
    apply(timeline, 0);
    const frame = motionHandFrame(rig.joints, timeline, side);
    const camera = new PerspectiveCamera(30, 1, 0.01, 100);
    camera.position.copy(frame.position);
    camera.up.copy(frame.up);
    camera.lookAt(frame.target);
    camera.updateMatrixWorld(true);
    const wrist = rig.joints
      .get(`${side}_wrist`)!
      .bone.getWorldPosition(new Vector3())
      .project(camera);
    const knuckle = rig.joints
      .get(`${side}_middle_1`)!
      .bone.getWorldPosition(new Vector3())
      .project(camera);
    expect(
      knuckle.y - wrist.y,
      "Raised fingers point up on screen",
    ).toBeGreaterThan(0.4);
    // A left-hand study must not apply its palm camera to the still-hanging right hand.
    const other = side === "left" ? "right" : "left";
    expect(motionHandFrame(rig.joints, timeline, other).up.toArray()).toEqual([
      0, 1, 0,
    ]);
  }
});

test("actual coin transforms stay finite and continuous through every knuckle handoff", () => {
  test.setTimeout(90_000);
  const discontinuities: {
    side: string;
    reverse: boolean;
    time: number;
    distanceMm: number;
    angleRadians: number;
  }[] = [];
  let samples = 0;
  for (const side of ["left", "right"] as const) {
    for (const reverse of [false, true]) {
      const timeline = validateRigProgram(createCoinRoll(side, reverse));
      const tracks = timeline.contacts ?? [];
      expect(tracks).toHaveLength(12);
      const sample = (time: number) => {
        apply(timeline, time);
        const coin = rig.props.snapshot().coin;
        expect(coin?.visible).toBe(true);
        expect(
          [...coin.position, ...coin.quaternion].every(Number.isFinite),
        ).toBe(true);
        const quaternion = new Quaternion(
          ...(coin.quaternion as [number, number, number, number]),
        );
        expect(quaternion.length()).toBeCloseTo(1, 8);
        samples++;
        return {
          position: new Vector3(...(coin.position as [number, number, number])),
          quaternion,
        };
      };
      for (const track of tracks) {
        for (let index = 0; index <= 8; index++)
          sample(track.start + (track.duration * index) / 8);
        const boundary = track.start + track.duration;
        // Separate demonstrations may intentionally reset at the outer loop;
        // internal knuckle transfers must retain the exact physical transform.
        if (
          boundary >= timeline.duration ||
          Math.abs(boundary - timeline.duration / 2) < 1e-8
        )
          continue;
        const before = sample(boundary - 1e-6),
          after = sample(boundary + 1e-6);
        const distanceMm = before.position.distanceTo(after.position) * 1000;
        const angleRadians = before.quaternion.angleTo(after.quaternion);
        if (distanceMm >= 0.1 || angleRadians >= 0.001)
          discontinuities.push({
            side,
            reverse,
            time: boundary,
            distanceMm,
            angleRadians,
          });
      }
    }
  }
  expect(discontinuities, JSON.stringify(discontinuities, null, 2)).toEqual([]);
  console.log(
    `Coin: ${samples} finite samples; no handoff jump above 0.1 mm or 0.001 radians.`,
  );
});
