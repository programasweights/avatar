import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const program = JSON.parse(readFileSync(new URL("../examples/gangnam-reference.json", import.meta.url), "utf8"));

test("the measured reference imports as a complete editable full-body study", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?example=gangnam&dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  await page.getByText("Edit motion", { exact: true }).click();
  await page.getByRole("button", { name: "Edit motion JSON", exact: true }).click();
  await page.getByLabel("Motion JSON", { exact: true }).fill(JSON.stringify(program));
  await page.getByRole("button", { name: "Apply program", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Motion program JSON" })).toBeHidden();
  const state = await page.evaluate(() => {
    const host = window as any;
    const studio = host.__motionStudio.snapshot();
    return { duration: host.__motion.timeline.duration, focus: studio.focus, character: studio.character,
      origin: studio.origin, program: studio.program };
  });
  expect(state.duration).toBeCloseTo(3.6, 9);
  expect(state.focus).toBe("body");
  expect(state.character).toBe("gangnam");
  expect(state.origin).toBe("Imported motion");
  expect(state.program).toEqual(program);
  expect(state.program.dance).toBeUndefined();
  await page.getByRole("button", { name: "Edit motion JSON", exact: true }).click();
  expect(JSON.parse(await page.getByLabel("Motion JSON", { exact: true }).inputValue())).toEqual(program);
  expect(errors).toEqual([]);
});
