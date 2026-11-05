import { expect, test, type Page } from "@playwright/test";

const hint = (page: Page) => page.locator(".form-hint");

/** Whether the browser's own bubble was held back, read once the app has handled the event. */
async function watchInvalid(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { invalidEvents: boolean[] }).invalidEvents = [];
    window.addEventListener("invalid", event => { setTimeout(() => (window as unknown as { invalidEvents: boolean[] }).invalidEvents.push(event.defaultPrevented)); }, true);
  });
}

test("a refused form explains itself in the app's own style and language, at the field", async ({ page }) => {
  await page.goto("/knowledge");
  const submit = page.getByRole("button", { name: "导入文档", exact: true });
  await expect(submit).toBeVisible();
  await watchInvalid(page);
  await submit.click();

  await expect(hint(page)).toHaveText("请先选择文件");
  await expect(hint(page)).toHaveAttribute("role", "alert");
  expect(await page.evaluate(() => (window as unknown as { invalidEvents: boolean[] }).invalidEvents)).toEqual([true]);
  const field = page.getByLabel("选择知识文档");
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const box = (await hint(page).boundingBox())!;
  const trigger = (await page.locator("label[data-form-invalid]").boundingBox())!;
  expect(box.y, "it sits at the visible control, not the hidden input").toBeGreaterThanOrEqual(trigger.y + trigger.height);
  expect(box.y - (trigger.y + trigger.height)).toBeLessThan(16);
  await page.screenshot({ path: test.info().outputPath("file.png") });

  await field.setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(hint(page)).toHaveCount(0);
  await expect(page.locator("[data-form-invalid]")).toHaveCount(0);
  await expect(field).not.toHaveAttribute("aria-invalid");
});

test("every kind of refusal gets its own sentence, only the first field speaks, and it leaves with the field", async ({ page }) => {
  await page.goto("/knowledge");
  await expect(page.getByRole("button", { name: "导入文档", exact: true })).toBeVisible();
  const refuse = async (attributes: Record<string, string>, value = "") => {
    await page.evaluate(({ attributes, value }) => {
      document.querySelector("#hint-form")?.remove();
      const form = document.createElement("form");
      form.id = "hint-form";
      form.style.cssText = "position:fixed;left:40px;top:40px;z-index:30";
      const input = document.createElement("input");
      for (const [name, content] of Object.entries(attributes)) input.setAttribute(name, content);
      input.id = "hint-field";
      input.value = value;
      const second = document.createElement("input");
      second.required = true;
      form.append(input, second);
      document.body.append(form);
      form.requestSubmit();
    }, { attributes, value });
  };
  await refuse({ required: "" });
  await expect(hint(page)).toHaveText("请填写此项");
  await refuse({ type: "url" }, "not a url");
  await expect(hint(page)).toContainText("完整的网址");
  await refuse({ type: "number", min: "2" }, "1");
  await expect(hint(page)).toHaveText("不能小于 2");
  await refuse({ type: "number", max: "5" }, "9");
  await expect(hint(page)).toHaveText("不能大于 5");
  await refuse({ pattern: "\\d+", title: "只能填写数字" }, "abc");
  await expect(hint(page)).toHaveText("只能填写数字");
  await expect(hint(page)).toHaveCount(1);

  const field = page.locator("#hint-field");
  await expect(field).toBeFocused();
  await field.fill("123");
  await expect(hint(page)).toHaveCount(0);

  await refuse({ required: "" });
  await expect(hint(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hint(page)).toHaveCount(0);

  await refuse({ required: "" });
  await expect(hint(page)).toBeVisible();
  await page.evaluate(() => document.querySelector("#hint-form")?.remove());
  await expect(hint(page), "it does not outlive the field").toHaveCount(0);

  await refuse({ required: "" });
  await expect(hint(page)).toBeVisible();
  await page.evaluate(() => { document.documentElement.classList.add("dark"); });
  await page.screenshot({ path: test.info().outputPath("dark.png") });
});
