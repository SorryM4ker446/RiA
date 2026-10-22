import { expect, test } from "@playwright/test";

// The desktop window can be as short as 640px. The rail tightens instead of
// scrolling, and it never shows a scrollbar.
test("the navigation rail fits short windows without a scrollbar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/chat");
  const rail = page.locator(".workspace-sidebar-body").first();
  await expect(rail).toBeVisible();
  // The desktop build adds a storage entry above settings.
  await rail.evaluate(node => {
    const footer = node.querySelector(".mt-auto");
    const link = footer?.querySelector(".workspace-nav-link");
    if (footer && link) footer.prepend(link.cloneNode(true));
  });
  for (const height of [640, 720, 800, 900]) {
    await page.setViewportSize({ width: 1440, height });
    // The rail eases between densities; measure where it settles.
    await rail.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)));
    const measured = await rail.evaluate(node => {
      const links = [...node.querySelectorAll(".workspace-nav-link")];
      return {
        overflow: node.scrollHeight - node.clientHeight,
        scrollbar: getComputedStyle(node).scrollbarWidth,
        lastLinkInside: links.at(-1)!.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom,
      };
    });
    expect(measured, `${height}px`).toEqual({ overflow: 0, scrollbar: "none", lastLinkInside: true });
  }
});
