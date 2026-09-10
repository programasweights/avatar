import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { PerspectiveCamera, Vector3 } from "three";
import { compileMotion } from "../src/motion/engine";

// Motion/rendering regressions use validated command fixtures. Language
// acceptance is measured separately through the real remote director.
test.use({ viewport: { width: 1280, height: 960 }, launchOptions: { args: [
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--enable-unsafe-swiftshader",
] } });

test("floor postures and lateral kicks stay visible through the normal body camera", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const outputs: Record<string, string> = { "Kneel down": "action kneel 1", "Kick to the left side": "action side_kick_left 1", "Lie down": "action lie_down 1" };
  await page.route(/\/api\/(?:v1\/avatar\/)?direct$/, route => {
    const instruction = route.request().postDataJSON().instruction;
    expect(outputs[instruction]).toBeDefined();
    return route.fulfill({ json: { output: outputs[instruction] } });
  });
  const evidence = [];
  for (const character of ["gangnam", "jade"]) {
    await page.goto(`/gangnam?dbg=1&quality=low&character=${character}`);
    await page.waitForFunction(() => !!(window as any).__motionStudio && !!(window as any).__motion);
    for (const [instruction, fractions] of [["Kneel down", [.4, 1]], ["Kick to the left side", [.5]], ["Lie down", [.35, .5, .65, 1]]] as const) {
      await page.getByLabel("Direction", { exact: true }).fill(instruction);
      await page.getByRole("button", { name: "Apply direction", exact: true }).click();
      await expect(page.getByRole("button", { name: "Apply direction", exact: true })).toBeEnabled();
      await expect(page.getByRole("alert")).toHaveCount(0);
      const state = await page.evaluate(() => (window as any).__motionStudio.snapshot());
      expect(state.focus).toBe("body");
      const duration = compileMotion(state.program).duration;
      await expect.poll(() => page.evaluate(() => (window as any).__motion.cameraSnapshot().transitioning)).toBe(false);
      for (const fraction of fractions) {
        const sample = await page.evaluate(time => {
          const studio = (window as any).__motionStudio, motion = (window as any).__motion;
          studio.seek(time); motion.seek(time);
          const vector = motion.rig.scene.position.clone();
          let minY = Infinity, minMesh = "";
          motion.rig.scene.traverse((mesh: any) => {
            if (!mesh.isMesh || !mesh.geometry.attributes.position || !mesh.visible) return;
            for (let index = 0; index < mesh.geometry.attributes.position.count; index++) {
              mesh.getVertexPosition(index, vector);
              vector.applyMatrix4(mesh.matrixWorld);
              if (vector.y < minY) { minY = vector.y; minMesh = mesh.name; }
            }
          });
          return { pose: motion.snapshot(), camera: motion.cameraSnapshot(), minY, minMesh };
        }, duration * fraction);
        evidence.push({ character, instruction, fraction, ...sample });
        await writeFile(testInfo.outputPath("rendered-ground-and-framing.json"), JSON.stringify(evidence, null, 2));
        expect(sample.minY, `${character} ${instruction} at ${fraction}: ${sample.minMesh} meets the floor`).toBeGreaterThan(-.02);
        const box = await page.locator(".motion-stage canvas").boundingBox();
        const camera = new PerspectiveCamera(30, box!.width / box!.height, .1, 1000);
        camera.position.fromArray(sample.camera.position); camera.up.fromArray(sample.camera.up);
        camera.lookAt(new Vector3().fromArray(sample.camera.target)); camera.updateMatrixWorld();
        for (const [joint, pose] of Object.entries(sample.pose) as [string, { position: number[] }][]) {
          const screen = new Vector3().fromArray(pose.position).project(camera);
          expect(Math.abs(screen.x), `${character} ${instruction} ${joint} horizontal framing`).toBeLessThan(.95);
          expect(Math.abs(screen.y), `${character} ${instruction} ${joint} vertical framing`).toBeLessThan(.95);
        }
        const name = `${character}-${instruction.replaceAll(" ", "-").toLowerCase()}-${fraction}`;
        const path = testInfo.outputPath(`${name}.png`);
        await page.locator(".motion-stage").screenshot({ path });
        await testInfo.attach(name, { path, contentType: "image/png" });
      }
    }
  }
  await testInfo.attach("rendered-ground-and-framing", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});
