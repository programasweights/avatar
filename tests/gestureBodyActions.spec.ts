import { expect, test } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PerspectiveCamera, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MotionRig } from "../src/motion/rig";
import { createBodyAction, createBodySequence } from "../src/motion/bodyActions";
import { applyCommands, validateRigProgram } from "../src/motion/director";
import { compileMotion, findNode, sampleTimeline } from "../src/motion/engine";
import { createDance } from "../src/motion/skills";

async function loadRig(assetName: string) {
  const bytes = await readFile(new URL(`../public/assets/${assetName}`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const asset = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  delete asset.images; delete asset.textures; delete asset.samplers; asset.materials = [];
  for (const mesh of asset.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const serialized = Buffer.from(JSON.stringify(asset));
  const json = Buffer.concat([serialized, Buffer.alloc((4 - serialized.length % 4) % 4, 32)]);
  const binary = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const model = await new GLTFLoader().parseAsync(Uint8Array.from(Buffer.concat([header, json, binary])).buffer, "");
  return new MotionRig(model.scene, model.animations);
}


const position = (pose: ReturnType<MotionRig["snapshot"]>, id: string) => new Vector3().fromArray(pose[id].position);
function palm(pose: ReturnType<MotionRig["snapshot"]>, side: "left" | "right") {
  const wrist = position(pose, `${side}_wrist`), index = position(pose, `${side}_index_1`), pinky = position(pose, `${side}_pinky_1`);
  const center = index.clone().add(pinky).multiplyScalar(.5).lerp(wrist, .4);
  return {
    center,
    fingers: position(pose, `${side}_middle_3`).sub(center).normalize(),
    inward: index.clone().sub(pinky).cross(center.clone().sub(wrist)).normalize().multiplyScalar(side === "left" ? -1 : 1),
  };
}

for (const asset of ["character.glb", "gangnam-character.glb"]) {
  test(`${asset}: claps bring upright palms together once per repetition with planted feet`, async () => {
    const rig = await loadRig(asset);
    try {
      for (const count of [1, 3, 8]) {
        const program = createBodyAction("clap", count), timeline = validateRigProgram(program);
        const cycle = 120 / program.bpm;
        expect(timeline.duration).toBeCloseTo(cycle * count);
        const at = (time: number) => { rig.apply(sampleTimeline(timeline, time)); return rig.snapshot(); };
        const rest = at(0);
        expect(palm(rest, "left").center.distanceTo(palm(rest, "right").center)).toBeGreaterThan(.3);
        let contacts = 0, touching = false;
        for (let frame = 0; frame <= count * 80; frame++) {
          const pose = at(cycle * frame / 80), left = palm(pose, "left"), right = palm(pose, "right");
          const distance = left.center.distanceTo(right.center);
          if (distance < .06 && !touching) { contacts++; touching = true; }
          if (distance > .12) touching = false;
          for (const side of ["left", "right"])
            expect(position(pose, `${side}_ankle`).distanceTo(position(rest, `${side}_ankle`)), "feet stay on their planted targets").toBeLessThan(.002);
        }
        expect(contacts).toBe(count);
        for (let repetition = 0; repetition < count; repetition++) {
          const pose = at(cycle * (repetition + .47)), left = palm(pose, "left"), right = palm(pose, "right");
          expect(left.center.distanceTo(right.center), "palm centers leave only the thickness of the two hands").toBeLessThan(.035);
          expect(left.center.distanceTo(right.center)).toBeGreaterThan(.015);
          expect(left.fingers.y).toBeGreaterThan(.99);
          expect(right.fingers.y).toBeGreaterThan(.99);
          expect(left.inward.dot(right.inward), "the palms face each other").toBeLessThan(-.99);
          expect(position(pose, "left_wrist").distanceTo(position(pose, "right_wrist"))).toBeLessThan(.04);
        }
        const finish = at(timeline.duration);
        for (const id of Object.keys(rest)) expect(position(finish, id).distanceTo(position(rest, id))).toBeLessThan(1e-7);
      }
    } finally { rig.props.dispose(); }
  });

  test(`${asset}: each punch extends the selected closed fist forward and returns to a stable guard`, async () => {
    const rig = await loadRig(asset);
    try {
      for (const side of ["left", "right"] as const) for (const count of [1, 3, 8]) {
        const other = side === "left" ? "right" : "left";
        const program = createBodyAction(`punch_${side}`, count), timeline = validateRigProgram(program), cycle = 120 / program.bpm;
        expect(timeline.duration).toBeCloseTo(cycle * count);
        const at = (time: number) => { rig.apply(sampleTimeline(timeline, time)); return rig.snapshot(); };
        const guard = at(0);
        let punches = 0, extended = false;
        for (let frame = 0; frame <= count * 80; frame++) {
          const pose = at(cycle * frame / 80);
          const advance = position(pose, `${side}_wrist`).z - position(guard, `${side}_wrist`).z;
          if (advance > .22 && !extended) { punches++; extended = true; }
          if (advance < .08) extended = false;
          for (const foot of ["left", "right"])
            expect(position(pose, `${foot}_ankle`).distanceTo(position(guard, `${foot}_ankle`))).toBeLessThan(.002);
          for (const joint of ["shoulder", "elbow", "wrist", "index_3"])
            expect(position(pose, `${other}_${joint}`).distanceTo(position(guard, `${other}_${joint}`)), "the other arm keeps its guard").toBeLessThan(1e-7);
        }
        expect(punches).toBe(count);
        for (let repetition = 0; repetition < count; repetition++) {
          const pose = at(cycle * (repetition + .43));
          const shoulder = position(pose, `${side}_shoulder`), elbow = position(pose, `${side}_elbow`), wrist = position(pose, `${side}_wrist`);
          expect(wrist.z - position(guard, `${side}_wrist`).z).toBeGreaterThan(.25);
          expect(elbow.clone().sub(shoulder).normalize().dot(wrist.clone().sub(elbow).normalize()), "the punching arm straightens").toBeGreaterThan(.99);
          for (const hand of ["left", "right"]) {
            // Compare the actual curved fingertips with the same arm pose and an open hand.
            const curled = position(pose, `${hand}_middle_3`).distanceTo(position(pose, `${hand}_wrist`));
            rig.apply(sampleTimeline(timeline, cycle * (repetition + .43)).filter(value => !/_(thumb|index|middle|ring|pinky)_/.test(value.target)));
            const open = rig.snapshot();
            expect(curled).toBeLessThan(position(open, `${hand}_middle_3`).distanceTo(position(open, `${hand}_wrist`)) * .8);
          }
        }
        const finish = at(timeline.duration);
        for (const id of Object.keys(guard)) expect(position(finish, id).distanceTo(position(guard, id))).toBeLessThan(1e-7);
      }
    } finally { rig.props.dispose(); }
  });
}

test("gesture commands compose with body actions and retain editable joint branches", () => {
  for (const action of ["clap", "punch_left", "punch_right"] as const) {
    const program = applyCommands(createDance("idle"), `action ${action} 3`);
    expect(program.dance).toBeUndefined();
    expect(compileMotion(program).duration).toBeCloseTo(120 / program.bpm * 3);
    expect(findNode(program.root, "arms.left.shoulder.z")).toBeDefined();
    expect(findNode(program.root, "arms.right.wrist.x")).toBeDefined();
  }
  const sequence = createBodySequence([{ action: "clap", count: 2 }, { action: "punch_right", count: 1 }]);
  expect(findNode(sequence.root, "body_step.0.arms.left.shoulder.z")).toBeDefined();
  expect(findNode(sequence.root, "body_step.1.arms.right.fist.middle.2")).toBeDefined();
  expect(compileMotion(sequence).duration).toBeCloseTo(120 / sequence.bpm * 3 + .28);
});


// Controlled remote responses exercise the real renderer. Language acceptance
// is covered independently by the live remote-director suites.
test.use({ viewport: { width: 1280, height: 960 }, launchOptions: { args: [
    "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader",
  ] } });
test.describe("rendered gestures", () => {
  test("palms meet and fists extend visibly on both characters with full-body framing", async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const outputs: Record<string, string> = { "Clap your hands": "action clap 1", "Punch with your left fist": "action punch_left 1", "Punch with your right fist": "action punch_right 1" };
    await page.route(/\/api\/(?:v1\/avatar\/)?direct$/, route => {
      const instruction = route.request().postDataJSON().instruction;
      expect(outputs[instruction]).toBeDefined();
      return route.fulfill({ json: { output: outputs[instruction], trace: { mocked: true } } });
    });
    for (const character of ["jade", "gangnam"]) {
      await page.goto(`/avatar?dbg=1&quality=low&character=${character}`);
      await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion);
      for (const [instruction, fraction] of [["Clap your hands", .47], ["Punch with your left fist", .43], ["Punch with your right fist", .43]] as const) {
        await page.getByLabel("Direction", { exact: true }).fill(instruction);
        await page.getByRole("button", { name: "Apply direction", exact: true }).click();
        await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled();
        await expect(page.getByRole("alert")).toHaveCount(0);
        const state = await page.evaluate(() => (window as any).__motionStudio.snapshot());
        expect(state.character).toBe(character);
        expect(state.focus).toBe("body");
        const timeline = compileMotion(state.program);
        await expect.poll(() => page.evaluate(() => (window as any).__motion.timeline)).toEqual(timeline);
        await page.locator(".motion-stage").scrollIntoViewIfNeeded();
        await expect.poll(() => page.evaluate(() => (window as any).__motion.cameraSnapshot().transitioning)).toBe(false);
        const sample = await page.evaluate(time => {
          const studio = (window as any).__motionStudio, motion = (window as any).__motion;
          studio.seek(time); motion.seek(time);
          return { pose: motion.snapshot(), camera: motion.cameraSnapshot() };
        }, timeline.duration * fraction);
        const box = await page.locator(".motion-stage canvas").boundingBox();
        const camera = new PerspectiveCamera(30, box!.width / box!.height, .1, 1000);
        camera.position.fromArray(sample.camera.position); camera.up.fromArray(sample.camera.up);
        camera.lookAt(new Vector3().fromArray(sample.camera.target)); camera.updateMatrixWorld();
        for (const [joint, pose] of Object.entries(sample.pose) as [string, { position: number[] }][]) {
          const screen = new Vector3().fromArray(pose.position).project(camera);
          expect(Math.abs(screen.x), `${joint} horizontal framing`).toBeLessThan(.95);
          expect(Math.abs(screen.y), `${joint} vertical framing`).toBeLessThan(.95);
        }
        const name = `${character}-${outputs[instruction].split(" ")[1]}.png`;
        const path = process.env.AVATAR_GESTURE_PREVIEW_DIR
          ? join(process.env.AVATAR_GESTURE_PREVIEW_DIR, name) : testInfo.outputPath(name);
        if (process.env.AVATAR_GESTURE_PREVIEW_DIR) await mkdir(process.env.AVATAR_GESTURE_PREVIEW_DIR, { recursive: true });
        await page.locator(".motion-stage").screenshot({ path });
        await testInfo.attach(name, { path, contentType: "image/png" });
      }
    }
  });
});
