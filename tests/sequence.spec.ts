import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { fingertip } from "../src/motion/contacts";
import {
  createDexteritySequence,
  defaultDexteritySequenceCommands,
  getDexteritySequenceInstructions,
} from "../src/motion/dexteritySequence";
import { validateRigProgram } from "../src/motion/director";
import {
  compileMotion,
  sampleContacts,
  sampleTimeline,
} from "../src/motion/engine";
import { MotionRig } from "../src/motion/rig";
import { frameHandOrbit } from "../src/motion/handCamera";
import { changeTempo } from "../src/motion/skills";
import type { PoseValue, Timeline } from "../src/motion/types";

async function loadActualRig(): Promise<MotionRig> {
  // Preserve the original GLB skeleton, animation, and geometry. Texture loading
  // is omitted because these numerical checks don't need a browser decoder.
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
  return new MotionRig(gltf.scene, gltf.animations);
}

let rig: MotionRig;
test.beforeAll(async () => {
  rig = await loadActualRig();
});
test.afterAll(() => {
  rig?.props.dispose();
});
const apply = (timeline: Timeline, time: number) =>
  rig.apply(
    sampleTimeline(timeline, time),
    sampleContacts(timeline, time),
    timeline.props,
  );
const key = (value: PoseValue) =>
  `${value.target}.${value.channel}.${value.axis}`;

test("the single editable sequence performs one pass per gesture and preserves supplied hand and direction", () => {
  for (const side of ["left", "right"] as const) {
    const commands = defaultDexteritySequenceCommands(side);
    const { program, cues } = createDexteritySequence(commands, side);
    const timeline = validateRigProgram(program);
    expect(program.root.kind).toBe("sequence");
    expect(timeline.duration).toBeCloseTo(16.8, 10);
    expect(cues.map((cue) => cue.view)).toEqual([
      "palm",
      "palm",
      "palm",
      "turn",
      "knuckles",
    ]);
    expect(cues.reduce((sum, cue) => sum + cue.duration, 0)).toBeCloseTo(
      timeline.duration,
      10,
    );
    expect(getDexteritySequenceInstructions(side)).toHaveLength(4);
    const tips = timeline.contacts!.filter(
      (contact) => contact.mode === "fingertips",
    );
    expect(
      tips.map((contact) => contact.mode === "fingertips" && contact.target),
    ).toEqual(
      ["index", "middle", "ring", "pinky"].map(
        (finger) => `${side}_${finger}_tip`,
      ),
    );
    const transfers = timeline.contacts!.filter(
      (contact) =>
        contact.mode === "prop_transfer" && contact.id.startsWith("coin."),
    );
    expect(transfers).toHaveLength(6);
    expect(
      transfers.map(
        (contact) => contact.mode === "prop_transfer" && contact.to,
      ),
    ).toEqual(
      ["middle", "ring", "pinky", "ring", "middle", "index"].map(
        (finger) => `${side}_${finger}_2`,
      ),
    );
    expect(() =>
      createDexteritySequence(
        commands.map((command) =>
          command.replace(/forward|reverse$/, (direction) =>
            direction === "forward" ? "reverse" : "forward",
          ),
        ),
        side,
      ),
    ).toThrow("directions");
    expect(() =>
      createDexteritySequence(commands, side === "left" ? "right" : "left"),
    ).toThrow("requested");
  }
  const commands = defaultDexteritySequenceCommands();
  for (const malformed of [
    [],
    commands.slice(1),
    [...commands, commands[0]],
    ["skill arm_wave left forward", ...commands.slice(1)],
    [commands[0].replace("left", "right"), ...commands.slice(1)],
    [commands[0] + "\n" + commands[0], ...commands.slice(1)],
  ])
    expect(() => createDexteritySequence(malformed)).toThrow();
});

test("every phase boundary is continuous on the actual rig, with a stationary body and released thumb contacts", () => {
  test.setTimeout(90_000);
  for (const side of ["left", "right"] as const) {
    const { program, cues } = createDexteritySequence(undefined, side);
    const timeline = validateRigProgram(program);
    const boundaries = [
      ...cues.slice(1).map((cue) => cue.start),
      timeline.duration - 0.5,
    ];
    for (const boundary of boundaries) {
      apply(timeline, boundary - 1e-6);
      const before = rig.snapshot();
      apply(timeline, boundary + 1e-6);
      const after = rig.snapshot();
      for (const target of Object.keys(before)) {
        const p = new Vector3(
          ...(before[target].position as [number, number, number]),
        );
        const q = new Quaternion(
          ...(before[target].quaternion as [number, number, number, number]),
        ).normalize();
        expect(
          p.distanceTo(
            new Vector3(
              ...(after[target].position as [number, number, number]),
            ),
          ),
          `${side} ${target} position at ${boundary}`,
        ).toBeLessThan(1e-5);
        expect(
          q.angleTo(
            new Quaternion(
              ...(after[target].quaternion as [number, number, number, number]),
            ).normalize(),
          ),
          `${side} ${target} angle at ${boundary}`,
        ).toBeLessThan(1e-4);
      }
    }
    const planted = [
      "hips",
      "left_hip",
      "right_hip",
      "left_knee",
      "right_knee",
      "left_ankle",
      "right_ankle",
    ];
    apply(timeline, 0);
    const original = rig.snapshot();
    for (let index = 1; index <= 61; index++) {
      apply(timeline, (timeline.duration * index) / 61);
      const actual = rig.snapshot();
      for (const target of planted) {
        actual[target].position.forEach((value, index) =>
          expect(value).toBeCloseTo(original[target].position[index], 10),
        );
        actual[target].quaternion.forEach((value, index) =>
          expect(value).toBeCloseTo(original[target].quaternion[index], 10),
        );
      }
    }
    const turn = cues.find((cue) => cue.id === "turn")!;
    const beforeTurn = sampleContacts(timeline, turn.start - 1e-5).filter(
      (contact) => contact.mode === "fingertips",
    );
    expect(beforeTurn).toHaveLength(1);
    expect(
      beforeTurn[0].mode === "fingertips" && beforeTurn[0].weight,
    ).toBeLessThan(1e-6);
    expect(
      sampleContacts(timeline, turn.start).some(
        (contact) => contact.mode === "fingertips",
      ),
    ).toBe(false);
  }
});

test("all four thumb contacts retain submillimeter precision after retiming and the coin enters without a pose jump", () => {
  test.setTimeout(90_000);
  let maximumError = 0;
  for (const side of ["left", "right"] as const) {
    for (const bpm of [108, 72]) {
      const commands = defaultDexteritySequenceCommands(side);
      const { program, cues } = createDexteritySequence(commands, side);
      const scale = program.bpm / bpm;
      const timeline = validateRigProgram(changeTempo(program, bpm));
      for (const contact of timeline.contacts ?? []) {
        if (contact.mode !== "fingertips") continue;
        for (const progress of [0.3, 0.475, 0.65]) {
          apply(timeline, contact.start + contact.duration * progress);
          const thumb = fingertip(
            rig.joints,
            contact.effector,
          ).getWorldPosition(new Vector3());
          const target = fingertip(rig.joints, contact.target).getWorldPosition(
            new Vector3(),
          );
          maximumError = Math.max(maximumError, thumb.distanceTo(target));
        }
      }
      const turn = cues.find((cue) => cue.id === "turn")!;
      apply(timeline, (turn.start + turn.duration * 0.5) * scale);
      expect(rig.props.snapshot().coin.visible).toBe(false);
      apply(timeline, (turn.start + turn.duration * 0.99) * scale);
      expect(rig.props.snapshot().coin.visible).toBe(true);
      const transfers = timeline.contacts!.filter(
        (contact) => contact.mode === "prop_transfer",
      );
      for (const transfer of transfers.slice(0, -1)) {
        const boundary = transfer.start + transfer.duration;
        apply(timeline, boundary - 1e-6);
        const before = rig.props.snapshot().coin;
        apply(timeline, boundary + 1e-6);
        const after = rig.props.snapshot().coin;
        expect(before.visible && after.visible).toBe(true);
        expect(
          new Vector3(
            ...(before.position as [number, number, number]),
          ).distanceTo(
            new Vector3(...(after.position as [number, number, number])),
          ),
        ).toBeLessThan(0.0001);
        expect(
          new Quaternion(
            ...(before.quaternion as [number, number, number, number]),
          ).angleTo(
            new Quaternion(
              ...(after.quaternion as [number, number, number, number]),
            ),
          ),
        ).toBeLessThan(0.001);
      }
      apply(timeline, timeline.duration);
      expect(rig.props.snapshot().coin.visible).toBe(true);
    }
  }
  expect(maximumError * 1000).toBeLessThan(1);
  console.log(
    `Sequence: 48 held contacts; maximum gap ${(maximumError * 1000).toFixed(3)} mm.`,
  );
});

test("the authored camera orbit stays outside the hand and its view is continuous through the turn", () => {
  for (const side of ["left", "right"] as const) {
    const { program, cues } = createDexteritySequence(undefined, side);
    const timeline = validateRigProgram(program),
      turn = cues.find((cue) => cue.id === "turn")!;
    for (let index = 0; index <= 100; index++) {
      const time = turn.start + (turn.duration * index) / 100;
      apply(timeline, time);
      const orbit = sampleTimeline(timeline, time).find(
        (value) => value.target === `${side}_hand_camera`,
      )!.value;
      const frame = frameHandOrbit(rig.joints, side, orbit);
      expect(
        [
          ...frame.position.toArray(),
          ...frame.target.toArray(),
          ...frame.up.toArray(),
        ].every(Number.isFinite),
      ).toBe(true);
      expect(frame.position.distanceTo(frame.target)).toBeGreaterThan(0.25);
      expect(frame.up.length()).toBeCloseTo(1, 8);
      expect(
        Math.abs(
          frame.up.dot(frame.position.clone().sub(frame.target).normalize()),
        ),
      ).toBeLessThan(1e-8);
    }
    for (const time of [
      turn.start,
      turn.start + turn.duration * 0.8,
      turn.start + turn.duration,
    ]) {
      const frameAt = (time: number) => {
        apply(timeline, time);
        return frameHandOrbit(
          rig.joints,
          side,
          sampleTimeline(timeline, time).find(
            (value) => value.target === `${side}_hand_camera`,
          )!.value,
        );
      };
      const a = frameAt(time - 1e-6),
        b = frameAt(time + 1e-6);
      expect(a.position.distanceTo(b.position)).toBeLessThan(0.0001);
      expect(a.target.distanceTo(b.target)).toBeLessThan(0.0001);
      expect(a.up.distanceTo(b.up)).toBeLessThan(0.0001);
    }
  }
  const { program } = createDexteritySequence();
  const reveal = (
    program.root as { children: any[] }
  ).children[3].children.find((node: any) => node.kind === "contact");
  for (const visibility of [
    { kind: "constant", value: NaN },
    {
      kind: "keys",
      points: [
        [1, 0],
        [0, 1],
      ],
    },
    { kind: "bogus" },
  ]) {
    reveal.visibility = visibility;
    expect(() => validateRigProgram(program)).toThrow();
  }
});

test("tempo edits retain the entire continuous program including camera, reveal, and contact timing", () => {
  const { program } = createDexteritySequence();
  const normal = compileMotion(program),
    slow = compileMotion(changeTempo(program, 72));
  expect(slow.duration).toBeCloseTo(normal.duration * 1.5, 10);
  for (let index = 0; index <= 100; index++) {
    const time = (normal.duration * index) / 100;
    const expected = sampleTimeline(normal, time),
      actual = sampleTimeline(slow, time * 1.5);
    const map = new Map(actual.map((value) => [key(value), value.value]));
    expect(map.size).toBe(expected.length);
    for (const value of expected)
      expect(map.get(key(value))).toBeCloseTo(value.value, 8);
    const contactA = sampleContacts(normal, time),
      contactB = sampleContacts(slow, time * 1.5);
    expect(contactA.length).toBe(contactB.length);
    contactA.forEach((contact, index) => {
      const other = contactB[index];
      expect(contact.mode).toBe(other.mode);
      if (contact.mode === "fingertips" && other.mode === "fingertips")
        expect(contact.weight).toBeCloseTo(other.weight, 9);
      if (contact.mode === "prop_transfer" && other.mode === "prop_transfer") {
        expect(contact.progress).toBeCloseTo(other.progress, 9);
        expect(contact.visibility ?? 1).toBeCloseTo(other.visibility ?? 1, 9);
      }
    });
  }
});
