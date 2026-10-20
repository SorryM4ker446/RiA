import assert from "node:assert/strict";
import { test } from "node:test";
import { zhCN } from "@/lib/locale/zh-CN";
import { enUS } from "@/lib/locale/en-US";
import { applyLocale, formatDateTime, getLocale, localizeMessage, normalizeLocale, subscribeLocale, systemLocale, t, tf } from "@/lib/locale";
import { ASSISTANT_BASE_PROMPT } from "@/lib/prompts";

test("English covers the Chinese catalog and preserves all interpolation variables", () => {
  assert.deepEqual(Object.keys(enUS).sort(), Object.keys(zhCN).sort());
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
    assert.ok(enUS[key].length, `${key} is empty`);
    assert.deepEqual(placeholders(enUS[key]), placeholders(zhCN[key]), `${key} has mismatched variables`);
    assert.doesNotMatch(enUS[key], /[\u4e00-\u9fff]/, `${key} still contains Chinese interface copy`);
  }
});

test("the default is Chinese, unsupported preferences fall back, and server rendering stays isolated", () => {
  for (const value of [null, undefined, "fr-FR", "en", {}, "zh-CN"]) assert.equal(normalizeLocale(value), "zh-CN");
  assert.equal(normalizeLocale("en-US"), "en-US");
  applyLocale("en-US");
  assert.equal(getLocale(), "zh-CN");
  assert.equal(t("nav.settings"), "设置");
  assert.equal(t("nav.settings", "en-US"), "Settings");
  assert.equal(tf("chat.conversations.loaded", { count: 3 }, "en-US"), "Loaded 3 conversations");
  assert.match(tf("chat.conversations.loaded", {}, "en-US"), /\{count\}/);
  const date = new Date("2026-10-20T12:00:00Z");
  const options: Intl.DateTimeFormatOptions = { timeZone: "UTC", month: "long", day: "numeric" };
  assert.equal(formatDateTime(date, options, "en-US"), date.toLocaleString("en-US", options));
});

test("renderer subscriptions update copy and dates without changing unknown or user content", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { lang: "zh-CN" } } });
  let calls = 0;
  const unsubscribe = subscribeLocale(() => calls++);
  try {
    applyLocale("en-US");
    assert.equal(document.documentElement.lang, "en-US");
    assert.equal(t("nav.home"), "Home");
    assert.equal(localizeMessage("无法读取媒体资源库。"), "Could not load the media library.");
    assert.equal(localizeMessage("用户自己的内容 123"), "用户自己的内容 123");
    applyLocale("en-US");
    assert.equal(calls, 1);
    applyLocale("zh-CN");
    assert.equal(localizeMessage("Could not load the media library."), "无法读取媒体资源库。");
    assert.equal(calls, 2);
    unsubscribe();
    applyLocale("en-US");
    assert.equal(calls, 2);
  } finally {
    unsubscribe();
    applyLocale("zh-CN");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("system language negotiation honors preference order and manual choices", () => {
  assert.equal(systemLocale(["zh-Hans-CN", "en-US"]), "zh-CN");
  assert.equal(systemLocale(["zh-TW"]), "zh-CN");
  assert.equal(systemLocale(["en-GB", "zh-CN"]), "en-US");
  assert.equal(systemLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(systemLocale(["fr-FR"]), "en-US");
  assert.equal(systemLocale([]), "en-US");
  assert.equal(normalizeLocale(null, "en-US"), "en-US");
  assert.equal(normalizeLocale("invalid", "en-US"), "en-US");
  assert.equal(normalizeLocale("zh-CN", "en-US"), "zh-CN");
});

test("chat instructions follow the latest user language independently of interface and tool text", () => {
  assert.match(ASSISTANT_BASE_PROMPT, /language of the user's latest message/);
  assert.match(ASSISTANT_BASE_PROMPT, /unless they explicitly request another language/);
  assert.match(ASSISTANT_BASE_PROMPT, /interface language, tool labels and tool output language must not determine/);
});
