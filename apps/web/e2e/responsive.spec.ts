import { expect, test } from "@playwright/test";

const WIDTHS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

for (const path of ["/", "/judge"]) {
  for (const vp of WIDTHS) {
    test(`${path} at ${vp.name} ${vp.width}px: no horizontal overflow, header fits`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(path);
      const { scroll, client } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(client);
      const header = await page.locator("header.top").boundingBox();
      expect(header).not.toBeNull();
      expect(header!.x + header!.width).toBeLessThanOrEqual(vp.width + 1);
    });
  }
}

test("primary actions are at least 36px tall on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const box = await page.getByRole("button", { name: /Start a demo run/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(36);
});
