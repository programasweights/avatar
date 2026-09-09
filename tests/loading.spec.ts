import { expect, test } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket("**", () => {});
});

test("an interrupted first character download recovers without reloading the page", async ({
  page,
}) => {
  let downloads = 0;
  let navigations = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  await page.route("**/assets/character.glb", (route) => {
    downloads++;
    return downloads === 1 ? route.abort("connectionreset") : route.continue();
  });
  await page.goto("/?dbg=1&quality=low");
  await page.waitForFunction(() => !!(window as any).__motion);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".motion-loading")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry character" }),
  ).toHaveCount(0);
  expect(downloads).toBe(2);
  expect(navigations).toBe(1);
  expect(errors).toEqual([]);
});

test("persistent download failure stays contained and a manual retry preserves the direction", async ({
  page,
}) => {
  let downloads = 0;
  let allowDownload = false;
  await page.route("**/assets/character.glb", (route) => {
    downloads++;
    return allowDownload
      ? route.continue()
      : route.fulfill({ status: 503, body: "Temporarily unavailable" });
  });
  await page.goto("/?dbg=1&quality=low");
  const input = page.getByRole("textbox", { name: "Direction", exact: true });
  await input.fill("Wiggle the right thumb");
  await expect(
    page.getByRole("button", { name: "Retry character" }),
  ).toBeVisible();
  expect(downloads).toBe(3);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".motion-loading")).not.toBeVisible();
  allowDownload = true;
  await page.getByRole("button", { name: "Retry character" }).click();
  await page.waitForFunction(() => !!(window as any).__motion);
  await expect(input).toHaveValue("Wiggle the right thumb");
  await expect(
    page.getByRole("button", { name: "Retry character" }),
  ).toHaveCount(0);
  expect(downloads).toBe(4);
});

test("a missing character shows a recovery action without automatic retrying", async ({
  page,
}) => {
  let downloads = 0;
  await page.route("**/local-assets/character.glb", (route) => {
    downloads++;
    return route.fulfill({ status: 404, body: "Not found" });
  });
  await page.goto("/?character=mixamo&quality=low");
  await expect(page.getByRole("alert")).toContainText(
    "The character could not be loaded.",
  );
  await expect(
    page.getByRole("button", { name: "Retry character" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(downloads).toBe(1);
});
