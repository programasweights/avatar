import { expect, test } from "@playwright/test";
import { applyCommands } from "../src/motion/director";
import {
  compileMotion,
  sampleContacts,
  sampleTimeline,
} from "../src/motion/engine";
import { createDexterity } from "../src/motion/dexterityDirector";
import { createDance } from "../src/motion/skills";
import type { DexteritySkill } from "../src/motion/dexterity";
import type { PoseValue, Timeline } from "../src/motion/types";

test.use({
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--enable-unsafe-swiftshader",
    ],
  },
});

const SKILLS: DexteritySkill[] = [
  "finger_ripple",
  "finger_touches",
  "arm_wave",
  "coin_roll",
];
const lowerBody = (pose: PoseValue[]) =>
  pose.filter(
    (value) =>
      value.target === "root" ||
      value.target === "hips" ||
      value.target.endsWith("_ik") ||
      /_(hip|knee|ankle|toes)$/.test(value.target),
  );
const key = (value: PoseValue) =>
  `${value.target}.${value.channel}.${value.axis}`;
function equalPose(actual: PoseValue[], expected: PoseValue[]) {
  const a = [...actual].sort((x, y) => key(x).localeCompare(key(y)));
  const b = [...expected].sort((x, y) => key(x).localeCompare(key(y)));
  expect(a.map(key)).toEqual(b.map(key));
  expect(
    a.filter((value, index) => Math.abs(value.value - b[index].value) > 1e-10),
  ).toEqual([]);
}
const upperTimeline = (timeline: Timeline): Timeline => ({
  ...timeline,
  tracks: timeline.tracks.filter(
    (track) =>
      track.ancestors.includes("arms") || track.ancestors.includes("details"),
  ),
});

test("all four directed skills preserve salsa and repeat their upper-body phrases to the shared boundary", () => {
  const original = createDance("salsa");
  const baseline = compileMotion(original);
  for (const side of ["left", "right"] as const) {
    for (const direction of ["forward", "reverse"] as const) {
      let program = original;
      for (const skill of SKILLS) {
        program = applyCommands(program, `skill ${skill} ${side} ${direction}`);
        const combined = compileMotion(program);
        const study = compileMotion(
          createDexterity(skill, side, direction === "reverse", original.bpm),
        );
        expect(combined.duration / baseline.duration).toBeCloseTo(
          Math.round(combined.duration / baseline.duration),
          10,
        );
        expect(combined.duration / study.duration).toBeCloseTo(
          Math.round(combined.duration / study.duration),
          10,
        );
        // Interior samples include the final phrase, well beyond the original
        // eight-beat dance. Test both the untouched gait and repeated trick.
        for (let i = 0; i < 17; i++) {
          const time = (combined.duration * (i + 0.371)) / 17;
          equalPose(
            lowerBody(sampleTimeline(combined, time)),
            lowerBody(sampleTimeline(baseline, time % baseline.duration)),
          );
          equalPose(
            sampleTimeline(upperTimeline(combined), time),
            sampleTimeline(upperTimeline(study), time % study.duration),
          );
          const actualContacts = sampleContacts(combined, time);
          const expectedContacts = sampleContacts(study, time % study.duration);
          expect(actualContacts.length).toBe(expectedContacts.length);
          actualContacts.forEach((contact, index) => {
            const expected = expectedContacts[index];
            expect(contact.mode).toBe(expected.mode);
            if (
              contact.mode === "fingertips" &&
              expected.mode === "fingertips"
            ) {
              expect([contact.effector, contact.target]).toEqual([
                expected.effector,
                expected.target,
              ]);
              expect(contact.weight).toBeCloseTo(expected.weight, 10);
            } else if (
              contact.mode === "prop_transfer" &&
              expected.mode === "prop_transfer"
            ) {
              expect([
                contact.prop,
                contact.from,
                contact.to,
                contact.rolls,
                contact.rollOffset,
              ]).toEqual([
                expected.prop,
                expected.from,
                expected.to,
                expected.rolls,
                expected.rollOffset,
              ]);
              expect(contact.progress).toBeCloseTo(expected.progress, 10);
            }
          });
        }
        if (skill === "finger_touches" || skill === "coin_roll") {
          expect(
            sampleContacts(combined, combined.duration - 0.001),
          ).toHaveLength(1);
        }
      }
    }
  }
});

test("joint and tempo edits remain usable after a repeated dexterity composition", () => {
  let program = createDance("salsa");
  for (const skill of SKILLS)
    program = applyCommands(program, `skill ${skill} left forward`);
  const original = compileMotion(program);
  const joint = compileMotion(applyCommands(program, "joint head y 17"));
  expect(joint.duration).toBe(original.duration);
  for (const fraction of [0.137, 0.417, 0.793, 0.999]) {
    const time = fraction * joint.duration;
    equalPose(
      lowerBody(sampleTimeline(joint, time)),
      lowerBody(sampleTimeline(original, time)),
    );
    expect(
      sampleTimeline(joint, time).find(
        (value) => value.target === "head" && value.axis === "y",
      )!.value,
    ).toBeCloseTo(
      sampleTimeline(original, time).find(
        (value) => value.target === "head" && value.axis === "y",
      )!.value + 17,
      10,
    );
  }
  const slower = compileMotion(applyCommands(program, "tempo 72"));
  expect(slower.duration / original.duration).toBeCloseTo(1.5, 10);
  for (const fraction of [0.137, 0.417, 0.793, 0.999]) {
    equalPose(
      sampleTimeline(slower, slower.duration * fraction),
      sampleTimeline(original, original.duration * fraction),
    );
    const a = sampleContacts(slower, slower.duration * fraction)[0];
    const b = sampleContacts(original, original.duration * fraction)[0];
    expect(a.mode).toBe("prop_transfer");
    if (a.mode === "prop_transfer" && b.mode === "prop_transfer")
      expect(a.progress).toBeCloseTo(b.progress, 10);
  }
});

test("unsupported phrase composition fails without altering the input program", () => {
  const original = createDance("salsa");
  const odd = structuredClone(original);
  const resize = (node: typeof odd.root): void => {
    if (node.kind === "curve" || node.kind === "contact")
      node.duration *= Math.SQRT2;
    else node.children.forEach(resize);
  };
  resize(odd.root);
  const saved = structuredClone(odd);
  expect(() => applyCommands(odd, "skill coin_roll left forward")).toThrow(
    "phrase lengths",
  );
  expect(odd).toEqual(saved);
});

test("the loaded rig keeps both legs and its root unchanged throughout chained dexterity phrases", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion, undefined, {
    timeout: 60_000,
  });
  let program = createDance("salsa");
  const baseline = compileMotion(program);
  const cases = [];
  for (const skill of SKILLS) {
    program = applyCommands(program, `skill ${skill} left forward`);
    const timeline = compileMotion(program);
    for (let i = 0; i < 17; i++) {
      const time = (timeline.duration * (i + 0.371)) / 17;
      cases.push({
        skill,
        time,
        original: sampleTimeline(baseline, time % baseline.duration),
        composed: sampleTimeline(timeline, time),
        contacts: sampleContacts(timeline, time),
        props: timeline.props ?? [],
      });
    }
  }
  const errors = await page.evaluate((samples) => {
    const rig = (window as any).__motion.rig;
    const targets = [
      "hips",
      "left_hip",
      "right_hip",
      "left_knee",
      "right_knee",
      "left_ankle",
      "right_ankle",
    ];
    const failures: string[] = [];
    for (const sample of samples) {
      rig.apply(sample.original);
      const original = rig.snapshot(),
        root = rig.scene.position.toArray();
      rig.apply(sample.composed, sample.contacts, sample.props);
      const composed = rig.snapshot();
      for (const target of targets) {
        for (const property of ["position", "quaternion"]) {
          if (
            original[target][property].some(
              (value: number, i: number) =>
                Math.abs(value - composed[target][property][i]) > 1e-9,
            )
          )
            failures.push(
              `${sample.skill} @ ${sample.time}: ${target}.${property}`,
            );
        }
      }
      if (
        root.some(
          (value: number, i: number) =>
            Math.abs(value - rig.scene.position.toArray()[i]) > 1e-9,
        )
      )
        failures.push(`${sample.skill} @ ${sample.time}: root.position`);
    }
    return failures;
  }, cases);
  expect(errors).toEqual([]);
});
