import { expect, test } from "@playwright/test";

// Smoke: the public pages load with no API keys, no database and no chain, with no error overlay or console errors.
for (const path of ["/", "/judge"]) {
  test(`${path} loads cleanly with no keys`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));

    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
    await expect(page).toHaveTitle(/Brake/);
    expect(errors).toEqual([]);
  });
}

test("home offers the no-wallet demo run", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stop a payment run before it clears.");
  await expect(page.getByRole("button", { name: /Start a demo run/ })).toBeEnabled();
});
