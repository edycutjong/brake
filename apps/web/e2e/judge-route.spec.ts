import { expect, test } from "@playwright/test";

// /judge must answer a cold visitor: no cookies, no session, no redirect.
test.use({ storageState: { cookies: [], origins: [] } });

test("GET /judge returns 200 with no credentials and states the claim", async ({ request, page }) => {
  const res = await request.get("/judge", { maxRedirects: 0 });
  expect(res.status()).toBe(200);

  await page.goto("/judge");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("We gave the agent the inbox. It still can't move a cent.");
  for (const h of ["The 30-second path", "Receipts", "Reproduce", "Honest limitations", "Links"]) {
    await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  }
});

test("/judge says where its measurements come from (live chain; forge suite pinned)", async ({ page }) => {
  await page.goto("/judge");
  await expect(page.getByText(/Measured on the live Aevum testnet 44005/)).toBeVisible();
});
