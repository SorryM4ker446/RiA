import { expect, test, type Page } from "@playwright/test";

async function desktop(page: Page, theme = "dark", locale: "zh-CN" | "en-US" = "zh-CN") {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 100);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(({ theme, locale }) => {
    localStorage.setItem("ui:theme", theme);
    let claim: Promise<string | null> | undefined;
    Object.assign(window, {
      riaDesktop: {
        getSettings: async () => ({ locale, hasOpenrouterApiKey: false, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "", windowBounds: null }),
        startup: {
          claim: () => claim ??= Promise.resolve(sessionStorage.getItem("startup-consumed") ? null : (sessionStorage.setItem("startup-consumed", "true"), "first-window")),
          present: () => new Promise<boolean>((resolve, reject) => Object.assign(window, { releaseStartup: resolve, rejectStartup: reject })),
        },
        windowControls: {
          state: async () => ({ maximized: false }), onMaximizedChange: () => () => {},
          minimize: () => {}, toggleMaximize: () => {}, close: () => {},
        },
      },
    });
  }, { theme, locale });
}

async function seekStartup(page: Page, time: number) {
  await page.evaluate(time => {
    const surface = document.querySelector(".desktop-startup")!;
    const workspace = document.querySelector(".desktop-startup-workspace")!;
    const stage = document.querySelector(".desktop-startup-stage")!;
    for (const animation of [...surface.getAnimations({ subtree: true }), ...workspace.getAnimations(), ...stage.getAnimations()]) {
      animation.pause();
      animation.currentTime = time;
    }
  }, time);
}

async function completeStartup(page: Page) {
  await page.evaluate(() => {
    const surface = document.querySelector(".desktop-startup")!;
    const workspace = document.querySelector(".desktop-startup-workspace")!;
    const stage = document.querySelector(".desktop-startup-stage")!;
    [...surface.getAnimations({ subtree: true }), ...workspace.getAnimations(), ...stage.getAnimations()].forEach(animation => animation.finish());
  });
}

for (const theme of ["dark", "light"]) {
  test(`desktop startup follows the saved ${theme} theme and hands off to the workspace once`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await desktop(page, theme);
    await page.goto("/chat");
    const startup = page.getByRole("region", { name: "RiA 启动动画" });
    await expect(startup).toBeVisible();
    await expect(page.locator(".desktop-startup-wordmark")).toHaveText("RiA");
    await expect(page.locator(".desktop-startup-workspace")).toHaveAttribute("inert", "");
    await expect(startup.getByRole("button", { name: "关闭", exact: true })).toBeVisible();
    expect(await startup.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(26, 27, 30)");
    await page.evaluate("window.releaseStartup(true)");
    await expect.poll(() => startup.evaluate(node => node.getAnimations().length)).toBe(1);
    await seekStartup(page, 600);
    await expect(page.locator(".desktop-startup-glyph").first()).toHaveCSS("opacity", "1");
    await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("opacity", "0");
    await page.screenshot({ path: info.outputPath(`startup-${theme}.png`) });
    await seekStartup(page, 850);
    expect(Number(await page.locator(".desktop-startup-mark").evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(.15);
    await expect(startup).toHaveCSS("opacity", "1");
    await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("opacity", "0");
    await expect(page.locator(".desktop-startup-stage")).toHaveCSS("background-color", theme === "light" ? "rgb(255, 255, 255)" : "rgb(26, 27, 30)");
    await seekStartup(page, 1000);
    await expect(page.locator(".desktop-startup-mark")).toHaveCSS("opacity", "0");
    const backdropAlpha = () => page.locator(".desktop-startup-stage").evaluate(node => {
      const color = getComputedStyle(node).backgroundColor;
      return color.startsWith("rgba(") ? Number(color.split(",").at(-1)!.replace(")", "")) : 1;
    });
    const middleAlpha = await backdropAlpha();
    expect(middleAlpha).toBeGreaterThan(0);
    expect(middleAlpha).toBeLessThan(1);
    expect(Number(await page.locator(".desktop-startup-workspace").evaluate(node => getComputedStyle(node).opacity))).toBeGreaterThan(0);
    await seekStartup(page, 1279);
    expect(await backdropAlpha()).toBeLessThan(.001);
    await expect(page.locator(".workspace-main")).toHaveCSS("background-color", /0\.88/);
    await completeStartup(page);
    await expect(startup).toHaveCount(0);
    await expect(page.locator(".desktop-startup-workspace")).not.toHaveAttribute("inert");
    await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("opacity", "1");
    await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("transform", "none");
    expect(await backdropAlpha()).toBe(0);
    await expect(page.locator(".workspace-main")).toHaveCSS("background-color", /0\.88/);
    await page.getByRole("link", { name: "知识库", exact: true }).click();
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(startup).toHaveCount(0);
    await page.reload();
    await expect(page.locator("main h1")).toContainText("知识库");
    await expect(startup).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("startup has no skip action and Escape leaves it playing until completion", async ({ page }) => {
  await desktop(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/");
  const startup = page.locator(".desktop-startup");
  await expect(startup).toBeVisible();
  await expect(page.getByRole("button", { name: "跳过动画", exact: true })).toHaveCount(0);
  await page.evaluate("window.releaseStartup(true)");
  await expect.poll(() => startup.evaluate(node => node.getAnimations().length)).toBe(1);
  await seekStartup(page, 400);
  await page.keyboard.press("Escape");
  await expect(startup).toBeVisible();
  await expect(page.locator(".desktop-startup-workspace")).toHaveAttribute("inert", "");
  await completeStartup(page);
  await expect(startup).toHaveCount(0);
  await expect(page.locator(".desktop-startup-workspace")).not.toHaveAttribute("inert");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("desktop startup reads an English device preference without losing the startup handoff", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await desktop(page, "dark", "en-US");
  await page.goto("/chat");
  const startup = page.getByRole("region", { name: "RiA startup animation", exact: true });
  await expect(startup).toBeVisible();
  await expect(startup.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page.evaluate("window.releaseStartup(true)");
  await expect.poll(() => startup.evaluate(node => node.getAnimations().length)).toBe(1);
  await completeStartup(page);
  await expect(startup).toHaveCount(0);
  await expect(page.locator(".desktop-startup-workspace")).not.toHaveAttribute("inert");
  expect(errors).toEqual([]);
});

test("reduced motion bypasses startup and changing the preference dismisses it", async ({ page }) => {
  await desktop(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect.poll(() => page.evaluate("typeof window.releaseStartup")).toBe("function");
  await expect(page.locator(".desktop-startup")).toHaveCount(0);
  await expect(page.locator(".desktop-startup-workspace")).not.toHaveAttribute("inert");
  await page.evaluate(() => sessionStorage.removeItem("startup-consumed"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect(page.locator(".desktop-startup")).toBeVisible();
  await page.evaluate("window.releaseStartup(true)");
  await expect.poll(() => page.locator(".desktop-startup").evaluate(node => node.getAnimations().length)).toBe(1);
  await seekStartup(page, 1000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".desktop-startup")).toHaveCount(0);
  await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("opacity", "1");
  await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("transform", "none");
  await expect(page.locator(".desktop-startup-stage")).not.toHaveAttribute("data-starting");
  await expect(page.locator(".desktop-startup-stage")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("failed and stalled readiness cannot block the workspace", async ({ page }) => {
  await desktop(page);
  await page.goto("/");
  await expect(page.locator(".desktop-startup")).toBeVisible();
  await page.evaluate("window.rejectStartup(new Error('Readiness unavailable'))");
  await expect(page.locator(".desktop-startup")).toHaveCount(0);
  await page.evaluate(() => sessionStorage.removeItem("startup-consumed"));
  await page.reload();
  await expect(page.locator(".desktop-startup")).toBeVisible();
  await expect.poll(() => page.evaluate("typeof window.releaseStartup")).toBe("function");
  await page.clock.runFor(2000);
  await expect(page.locator(".desktop-startup")).toHaveCount(0);
  await expect(page.locator(".desktop-startup-workspace")).not.toHaveAttribute("inert");
  await expect(page.locator(".desktop-startup-workspace")).toHaveCSS("opacity", "1");
  await page.evaluate("window.releaseStartup(true)");
  await expect(page.locator(".desktop-startup")).toHaveCount(0);
});
