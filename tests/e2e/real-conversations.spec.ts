import type { Page } from "@playwright/test";
import { test, expect, type RealModel } from "../helpers/real-model";
import { browserApi, browserData } from "../helpers/browser-api";
import { openRecentConversations } from "../helpers/conversations";

/*
 * Conversations against a real model (`npm run test:real`): answers that stream
 * for real, at the provider's own pace, in several conversations at once.
 * Timings are printed and attached, not judged (they depend on the provider);
 * what is judged is that each answer is shown and saved once, whole, and that
 * nothing sent comes back into a message box.
 */
test.describe.configure({ timeout: 300_000 });

const ask = (topic: string) => `Write about 400 words on ${topic}, in plain paragraphs, no headings, no lists, no tools.`;
const title = (page: Page) => page.locator(".chat-toolbar h3");
const box = (page: Page) => page.getByPlaceholder(/输入你的问题/);
const lastAnswer = (page: Page) => page.getByTestId("message-list").locator('[data-message-role="assistant"]').last();
// The answer's own text, not its reasoning, which folds away once the text begins.
const answerLength = (page: Page) => lastAnswer(page).locator(".markdown-message").last().innerText({ timeout: 500 }).then(text => text.length).catch(() => 0);
const stopButton = (page: Page) => page.getByRole("button", { name: "停止", exact: true });
async function send(page: Page, text: string) {
  await box(page).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => answerLength(page), { timeout: 60_000 }).toBeGreaterThan(40);
}
const roles = async (page: Page, real: RealModel, id: string) => (await browserData(page, `${real.origin}/api/conversations/${id}/messages`) as { role: string }[]).map(message => message.role[0]).join("");
async function answered(page: Page, real: RealModel, id: string) {
  await expect.poll(async () => (await browserData(page, `${real.origin}/api/conversations/${id}`) as { answering: boolean }).answering, { timeout: 120_000 }).toBe(false);
}

test("switching between conversations answering at once shows each where it has got to @real", async ({ page, real }, info) => {
  const names = ["甲", "乙", "丙", "丁"];
  const topics = ["tides", "volcanoes", "honeybees", "glassmaking"];
  const log: string[] = [];
  const note = (line: string) => { log.push(line); console.log(line); };

  // The first conversation is made by its first message.
  await page.goto(`${real.origin}/chat`);
  await send(page, ask(topics[0]));
  await expect.poll(async () => (await browserData(page, `${real.origin}/api/conversations`) as unknown[]).length).toBe(1);
  const ids = [(await browserData(page, `${real.origin}/api/conversations`) as { id: string }[])[0].id];
  expect((await browserApi(page, `${real.origin}/api/conversations/${ids[0]}`, "PATCH", { title: names[0] })).status).toBe(200);
  for (const name of names.slice(1)) ids.push((await browserApi(page, `${real.origin}/api/conversations`, "POST", { title: name })).body.data.id);
  const sidebar = await openRecentConversations(page);
  const row = (name: string) => sidebar.getByRole("button", { name: new RegExp(`^${name}`) });
  const readAgain: string[] = [];
  page.on("request", request => { const match = request.url().match(/\/api\/chat\/([^/]+)\/stream/); if (request.method() === "GET" && match) readAgain.push(names[ids.indexOf(match[1])] ?? match[1]); });
  await page.evaluate(() => {
    const target = window as unknown as { __long: number[] };
    target.__long = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) target.__long.push(Math.round(entry.duration)); }).observe({ type: "longtask" });
  });
  const takeLong = () => page.evaluate(() => { const target = window as unknown as { __long: number[] }; const all = target.__long; target.__long = []; return all; });
  for (const index of [1, 2]) {
    await row(names[index]).click(); await expect(title(page)).toHaveText(names[index]);
    await send(page, ask(topics[index]));
  }
  async function switchTo(name: string) {
    await takeLong();
    const started = Date.now();
    await row(name).click();
    await expect(title(page)).toHaveText(name);
    await expect.poll(() => answerLength(page), { timeout: 30_000 }).toBeGreaterThan(40);
    const shownIn = Date.now() - started;
    const first = await answerLength(page);
    await page.waitForTimeout(1200);
    const later = await answerLength(page);
    expect(later, "an answer on screen never goes back").toBeGreaterThanOrEqual(first);
    expect(await box(page).inputValue(), "nothing sent comes back into the message box").toBe("");
    note(`→ ${name}: shown in ${shownIn} ms, answer ${first} → ${later} chars over 1.2 s${await stopButton(page).isVisible() ? " (still answering)" : ""}, long tasks ${JSON.stringify(await takeLong())}`);
  }
  for (const name of ["甲", "乙", "丙", "甲", "乙"]) await switchTo(name);
  // A fourth: three are now behind, one more than are read in the background.
  await row("丁").click(); await expect(title(page)).toHaveText("丁");
  await send(page, ask(topics[3]));
  for (const name of ["甲", "乙", "丙", "丁"]) await switchTo(name);
  note(`read again from the service: ${JSON.stringify(readAgain)}`);

  // Each answer ends, is saved once, and shows as kept here what opening it afresh shows.
  const kept: string[] = [];
  for (const [index, id] of ids.entries()) {
    await answered(page, real, id);
    await row(names[index]).click(); await expect(title(page)).toHaveText(names[index]);
    await expect(stopButton(page)).toHaveCount(0);
    kept.push((await lastAnswer(page).innerText()).replace(/\s+/g, " ").trim());
    expect(await roles(page, real, id)).toBe("ua");
    expect(await box(page).inputValue()).toBe("");
  }
  for (const [index, id] of ids.entries()) {
    await page.goto(`${real.origin}/chat?conversationId=${id}`);
    await expect(title(page)).toHaveText(names[index]);
    await expect.poll(() => answerLength(page)).toBeGreaterThan(40);
    expect((await lastAnswer(page).innerText()).replace(/\s+/g, " ").trim(), `${names[index]} as kept and as saved`).toBe(kept[index]);
  }
  await info.attach("switching", { body: log.join("\n"), contentType: "text/plain" });
});

test("an answer read again after a reload, then stopped, is kept once and the next question goes on from it @real", async ({ page, real }) => {
  const id = (await browserApi(page, `${real.origin}/api/conversations`, "POST", { title: "Reload and stop" })).body.data.id;
  await page.goto(`${real.origin}/chat?conversationId=${id}`);
  await expect(title(page)).toHaveText("Reload and stop");
  await send(page, ask("lighthouses"));
  // Reloaded mid-answer: read again from the service, once, and still moving.
  await page.reload();
  await expect.poll(() => answerLength(page), { timeout: 30_000 }).toBeGreaterThan(40);
  const before = await answerLength(page);
  await expect(stopButton(page)).toBeVisible();
  await expect.poll(() => answerLength(page), { timeout: 15_000 }).toBeGreaterThan(before);
  await stopButton(page).click();
  await answered(page, real, id);
  await expect(stopButton(page)).toHaveCount(0);
  expect(await roles(page, real, id)).toBe("ua");
  expect(await box(page).inputValue()).toBe("");
  const shown = (await lastAnswer(page).innerText()).replace(/\s+/g, " ").trim();
  const saved = (await browserData(page, `${real.origin}/api/conversations/${id}/messages`) as { content: string }[])[1].content.replace(/\s+/g, " ").trim();
  expect(saved.length, "what was written before the stop is kept").toBeGreaterThan(40);
  expect(shown.split(saved.slice(0, 60)).length - 1, "and shown once").toBeLessThanOrEqual(1);
  // The conversation goes on from what was kept.
  await send(page, "In one sentence, what was your previous answer about?");
  await answered(page, real, id);
  expect(await roles(page, real, id)).toBe("uaua");
  expect((await lastAnswer(page).innerText()).toLowerCase()).toContain("lighthouse");
});
