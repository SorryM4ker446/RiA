import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi } from "../helpers/browser-api";

// Reuse the already-built runtime after Playwright's webServer is ready.
// This extra server enables real authentication without sharing the demo test database.
let server: Awaited<ReturnType<typeof startStandaloneServer>>;
let origin: string;

test.beforeAll(async () => {
  server = await startStandaloneServer();
  origin = server.origin;
});

test.afterAll(async () => { await server?.close(); });

test("real browser authentication, CSRF rejection, Session expiry and login throttling", { tag: "@integration" }, async ({ page, request }) => {
  const email = `${randomUUID()}@example.invalid`;
  const password = randomUUID();
  const unauthorized = await request.post(`${origin}/api/chat`, { data: "invalid" });
  expect(unauthorized.status()).toBe(401);
  expect((await unauthorized.json()).error.code).toBe("UNAUTHORIZED");
  await page.goto(`${origin}/register`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(email);
  await page.getByPlaceholder("密码（至少 8 位）").fill(password);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "app_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  expect((await browserApi(page, `${origin}/api/auth/me`)).status).toBe(200);
  const malformed = await page.evaluate(async () => {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ id: "u", role: "user", parts: [{ type: "text", text: 12 }] }] }) });
    return { status: response.status, body: await response.json() };
  });
  expect(malformed.status).toBe(400);
  expect(malformed.body.error.code).toBe("VALIDATION_ERROR");
  const foreign = await page.context().request.post(`${origin}/api/conversations`, { headers: { Origin: "https://outside.invalid" }, data: { title: "Must not be created" } });
  expect(foreign.status()).toBe(403);
  expect((await foreign.json()).error.code).toBe("FORBIDDEN");
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Authenticated browser" }) });
    return response.status;
  });
  expect(created).toBe(201);
  const chatResponse = page.waitForResponse((response) => response.url() === `${origin}/api/chat`);
  await page.getByPlaceholder(/输入你的问题/).fill("Validate the normal chat request");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const unconfigured = await chatResponse;
  expect(unconfigured.status()).toBe(503);
  expect((await unconfigured.json()).error.code).toBe("CONFIGURATION_ERROR");
  server.expireSessions();
  const expired = await browserApi(page, `${origin}/api/auth/me`);
  expect(expired.status).toBe(401);
  expect(expired.body.error.code).toBe("UNAUTHORIZED");
  expect(server.readRows("SELECT id FROM sessions")).toHaveLength(0);
  await page.goto(`${origin}/chat`);
  await expect(page).toHaveURL(`${origin}/login`);
  await page.goto(`${origin}/knowledge`);
  await expect(page).toHaveURL(`${origin}/login`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(email);
  await page.getByPlaceholder("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
  expect((await browserApi(page, `${origin}/api/auth/me`)).status).toBe(200);
  expect((await browserApi(page, `${origin}/api/auth/logout`, "POST")).status).toBe(200);
  expect(server.readRows("SELECT id FROM sessions")).toHaveLength(0);
  expect((await browserApi(page, `${origin}/api/auth/me`)).status).toBe(401);
  for (let index = 0; index < 19; index++) {
    expect((await request.post(`${origin}/api/auth/login`, { data: { email, password: randomUUID() }, headers: { "x-forwarded-for": `198.51.100.${index}` } })).status()).toBe(401);
  }
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(email);
  await page.getByPlaceholder("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "登录失败" })).toContainText("秒后可重试");
  const limited = await request.post(`${origin}/api/auth/login`, { data: { email, password } });
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
});
