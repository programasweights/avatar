import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tools/reference-fit.html");
  await page.waitForFunction(() => !!(window as any).__referenceFit);
});

test("offline reference preparation rejects bad timing and explicitly records missing landmarks", async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = (window as any).__referenceFit;
    const points = Array.from({ length: 33 }, () => ({ x: .4, y: .6, z: .2, visibility: 1 }));
    const make = (time: number) => ({ time, landmarks: structuredClone(points), worldLandmarks: structuredClone(points) });
    const input = { width: 640, height: 360, fps: 25, frames: [make(2), make(2.24), make(2.8)] };
    input.frames[1].landmarks[15].visibility = 0;
    const prepared = api.prepareReference(input, { smoothRadius: 0 });
    let invalidTiming = "";
    input.frames[2].time = 2.24;
    try { api.prepareReference(input); } catch (error) { invalidTiming = String(error); }
    let invalidManual = "";
    try { api.prepareReference({ width: 640, height: 360, fps: 25, manualFrames: [{ time: 0, points: {} }, { time: 1, points: {} }] }); }
    catch (error) { invalidManual = String(error); }
    return { duration: prepared.duration, inferred: prepared.inferred, first: prepared.frames[0].world.left_shoulder, invalidTiming, invalidManual };
  });
  expect(result.duration).toBeCloseTo(.8, 9);
  expect(result.inferred).toEqual([{ frame: 1, joint: "left_wrist", space: "landmarks" }]);
  expect(result.first).toEqual({ x: .4, y: -.6, z: -.2 });
  expect(result.invalidTiming).toContain("increase strictly");
  expect(result.invalidManual).toContain("finite pixel pair for left_shoulder");
});

test("reference fit preserves source duration and normalizes source bone lengths on the shipped rig", async ({ page }) => {
  test.setTimeout(120_000);
  const result = await page.evaluate(async () => {
    const api = (window as any).__referenceFit;
    api.rig.apply([]);
    const rest = api.rig.snapshot();
    const ids: Record<string, number> = { left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14, left_wrist: 15, right_wrist: 16, left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26, left_ankle: 27, right_ankle: 28 };
    const make = (scale: number) => ({ width: 640, height: 360, fps: 25, frames: [4, 4.12, 4.64].map(time => {
      const landmarks = Array.from({ length: 33 }, () => null) as any[];
      const worldLandmarks = Array.from({ length: 33 }, () => null) as any[];
      for (const [joint, id] of Object.entries(ids)) {
        const [x, y, z] = rest[joint].position;
        landmarks[id] = { x: (320 + x * 160) / 640, y: (345 - y * 160) / 360 };
        worldLandmarks[id] = { x: x * scale, y: -y * scale, z: -z * scale };
      }
      return { time, landmarks, worldLandmarks };
    }) });
    const a = await api.fit(make(1), { smoothRadius: 0 });
    const b = await api.fit(make(1.7), { smoothRadius: 0 });
    const curves = (node: any): any[] => node.kind === "curve" ? [node] : (node.children ?? []).flatMap(curves);
    const left = curves(a.program.root), right = curves(b.program.root);
    const values = (curve: any) => curve.curve.kind === "keys" ? curve.curve.points.map((p: number[]) => p[1]) : [curve.curve.value];
    return {
      duration: a.report.duration,
      fittedFrames: a.report.fittedFrames,
      ids: a.program.root.children.map((node: any) => node.id),
      maxDifference: Math.max(...left.flatMap((curve: any, index: number) => values(curve).map((n: number, j: number) => Math.abs(n - values(right[index])[j])))),
      finite: left.flatMap(values).every(Number.isFinite),
      dance: a.program.dance ?? null,
    };
  });
  expect(result.duration).toBeCloseTo(.64, 9);
  expect(result.fittedFrames).toBe(3);
  expect(result.ids).toEqual(["feet", "torso", "arms", "details"]);
  expect(result.maxDifference).toBeLessThan(.001);
  expect(result.finite).toBe(true);
  expect(result.dance).toBeNull();
});
