import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { Box3, Vector3 } from "three";
import type { Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createGangnamLaunch, gangnamLaunchSourceTime } from "../tools/gangnam-launch";
import { createGangnam, changeGangnamSupport } from "../src/motion/gangnam";
import { compileMotion, findNode, sampleTimeline, updateNode } from "../src/motion/engine";
import { validateRigProgram } from "../src/motion/director";
import { MotionRig } from "../src/motion/rig";
import type { MotionProgram, PoseValue, Timeline } from "../src/motion/types";

let model: Object3D;
let rig: MotionRig;
test.beforeAll(async () => {
  const bytes = await readFile(new URL("../public/assets/gangnam-character.glb", import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, "");
  model = gltf.scene;
  rig = new MotionRig(model, gltf.animations);
});
test.afterAll(() => rig?.props.dispose());

const key = (pose: Pick<PoseValue, "target" | "channel" | "axis">) => `${pose.target}.${pose.channel}.${pose.axis}`;
const values = (timeline: Timeline, time: number) => new Map(sampleTimeline(timeline, time).map((p) => [key(p), p.value]));
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));

test("launch has exactly three commands and holds right support through its final frame", () => {
  const { program, cues, launch } = createGangnamLaunch();
  const timeline = validateRigProgram(program);
  expect(timeline.duration).toBeCloseTo(20 * 60 / 132, 10);
  expect(launch.phaseOffsetBeats).toBe(0.3);
  expect(cues).toHaveLength(3);
  expect(cues.map((cue) => cue.instruction)).toEqual([
    "Dance Gangnam Style.", "Now on one foot.", "Switch to the opposite foot.",
  ]);
  expect(launch.edits.map(({ support, beat }) => ({ support, beat }))).toEqual([
    { support: "left", beat: 4 }, { support: "right", beat: 10 },
  ]);
  for (const edit of launch.edits) {
    expect(edit.start).toBeCloseTo(edit.beat * 60 / 132, 10);
    expect(edit.settled - edit.start).toBeCloseTo(0.3, 10);
  }
  expect(cues.reduce((sum, cue) => sum + cue.duration, 0)).toBeCloseTo(timeline.duration, 10);
  expect(program.dance).toBeUndefined(); // A sequence has no single support configuration.
  expect(launch.finalSupport).toBe("right");
  for (const id of ["feet", "balance", "arms", "torso.groove", "details"])
    expect(findNode(program.root, id)).toBeDefined();
  const last = values(timeline, timeline.duration);
  const expected = values(compileMotion(createGangnam({ support: "right" })), gangnamLaunchSourceTime(timeline.duration));
  for (const [channel, value] of expected) expect(last.get(channel), channel).toBeCloseTo(value, 8);
});

test("both support edits and the source-cycle boundary preserve exact upper-body phase", () => {
  const source = compileMotion(createGangnam());
  const { program, launch } = createGangnamLaunch();
  const output = compileMotion(program);
  const upper = source.tracks.filter((t) => !t.ancestors.includes("feet") && !t.ancestors.includes("balance"));
  const times = Array.from({ length: 281 }, (_, i) => launch.duration * i / 280);
  for (const boundary of [...launch.edits.flatMap((e) => [e.start, e.settled]), launch.sourceDuration - 0.3 * 60 / 132])
    times.push(boundary - 1e-6, boundary, boundary + 1e-6);
  for (const time of times) {
    const expected = values(source, gangnamLaunchSourceTime(time));
    const actual = values(output, time);
    for (const track of upper) expect(actual.get(key(track)), `${track.id} at ${time}`).toBeCloseTo(expected.get(key(track))!, 8);
  }
});

test("captured support programs retain their curves and reject unrelated upper-body changes", () => {
  let both = createGangnam();
  both = { ...both, root: updateNode(both.root, "grip.left.index.1", (node) => node.kind === "curve"
    ? { ...node, curve: { kind: "constant", value: 49 } } : node) };
  const left = changeGangnamSupport(both, "left");
  let right = changeGangnamSupport(left, "right");
  right = { ...right, root: updateNode(right.root, "feet.left.x", (node) => node.kind === "curve"
    ? { ...node, curve: { kind: "constant", value: 0.025 } } : node) };
  const before = JSON.stringify({ both, left, right });
  const { program } = createGangnamLaunch({ both, left, right });
  expect(JSON.stringify({ both, left, right })).toBe(before);
  const final = values(compileMotion(program), 9);
  expect(final.get("left_index_1.rotation.z")).toBe(49);
  expect(final.get("left_foot_ik.position.x")).toBeCloseTo(0.025, 10);
  expect(() => createGangnamLaunch({ left: createGangnam({ support: "right" }) })).toThrow("left support");
  expect(() => createGangnamLaunch({ both: createGangnam({ bpm: 96 }) })).toThrow("132 BPM");
  expect(() => createGangnamLaunch({ both, left: createGangnam({ support: "left" }) })).toThrow("upper body");
  const malformed: MotionProgram = { ...both, root: updateNode(both.root, "feet.left.x", (node) => node.kind === "curve"
    ? { ...node, target: "left_hand" } : node) };
  expect(() => createGangnamLaunch({ both: malformed, left })).toThrow("support channel");
});

test("the shipped rig keeps each commanded free leg visibly raised, with continuous support transfers", async () => {
  const { program, launch } = createGangnamLaunch();
  const timeline = validateRigProgram(program);
  rig.apply([]);
  const rest = rig.snapshot();
  const totalBounds = new Box3();
  const boundsPath = process.env.GANGNAM_LAUNCH_BOUNDS;
  const boundSamples: { time: number; min: number[]; max: number[] }[] = [];
  for (let frame = 0; frame <= 240; frame++) {
    const time = launch.duration * frame / 240;
    rig.apply(sampleTimeline(timeline, time));
    const snapshot = rig.snapshot();
    expect(Object.values(snapshot).flatMap((p) => [...p.position, ...p.quaternion]).every(Number.isFinite)).toBe(true);
    for (const side of ["left", "right"])
      expect(snapshot[`${side}_toes`].position[1]).toBeGreaterThan(0.01);
    const support = time >= launch.edits[1].settled ? "right"
      : time >= launch.edits[0].settled && time < launch.edits[1].start ? "left" : undefined;
    if (support) {
      const free = support === "left" ? "right" : "left";
      expect(snapshot[`${free}_ankle`].position[1] - snapshot[`${support}_ankle`].position[1]).toBeGreaterThan(0.34);
      expect(snapshot[`${support}_ankle`].position[1] - rest[`${support}_ankle`].position[1]).toBeLessThan(0.036);
      expect(Math.abs(snapshot.hips.position[0] - snapshot[`${support}_ankle`].position[0])).toBeLessThan(0.04);
    }
    if (boundsPath && frame % 4 === 0) {
      model.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(model, true);
      totalBounds.union(bounds);
      boundSamples.push({ time, min: bounds.min.toArray(), max: bounds.max.toArray() });
    }
  }
  for (const boundary of launch.edits.flatMap((edit) => [edit.start, edit.settled])) {
    rig.apply(sampleTimeline(timeline, boundary - 0.0001));
    const before = rig.snapshot();
    rig.apply(sampleTimeline(timeline, boundary + 0.0001));
    const after = rig.snapshot();
    for (const joint of Object.keys(before))
      expect(distance(before[joint].position, after[joint].position), `${joint} at ${boundary}`).toBeLessThan(0.001);
  }
  if (boundsPath) await writeFile(boundsPath, JSON.stringify({
    min: totalBounds.min.toArray(), max: totalBounds.max.toArray(),
    center: totalBounds.getCenter(new Vector3()).toArray(), size: totalBounds.getSize(new Vector3()).toArray(),
    method: "Exact skinned vertex bounds of the shipped GLB at 61 poses across the 20-beat launch.", samples: boundSamples,
  }, null, 2));
});
