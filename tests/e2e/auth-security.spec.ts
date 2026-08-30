import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";

// Reuse the already-built runtime after Playwright's webServer is ready.
// This extra server enables real authentication without sharing the demo test database.
let server: ChildProcess;
let origin: string;
const root = resolve(".desktop-data/test", `auth-${process.pid}-${randomUUID()}`);
const database = join(root, "app.db");

test.beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  mkdirSync(root, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", APP_RUNTIME: "test", AUTH_DISABLED: "0", APP_ORIGIN: "",
    HOSTNAME: "127.0.0.1", PORT: String(port), LOCAL_DATABASE_FILE: database,
    DATABASE_URL: `file:${database.replaceAll("\\", "/")}`, MEDIA_DIRECTORY: join(root, "media"),
    LEGACY_VIDEO_DIRECTORY: join(root, "legacy-videos"), OPENROUTER_API_KEY: "", TAVILY_API_KEY: "", OUTBOUND_PROXY_URL: "",
  };
  execFileSync(process.execPath, ["scripts/run-with-local-db.mjs", "--migrate", "node", "--version"], { env, windowsHide: true, timeout: 30_000, stdio: "pipe" });
  server = spawn(process.execPath, [".desktop-runtime/server.js"], { env, windowsHide: true, stdio: "ignore" });
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error("Authentication test server exited before readiness");
    return fetch(`${origin}/api/health`).then((response) => response.status).catch(() => 0);
  }, { timeout: 30_000 }).toBe(200);
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    server.kill();
    await exited;
  }
  if (dirname(root) !== resolve(".desktop-data/test")) throw new Error("Unexpected auth test directory");
  rmSync(root, { recursive: true, force: true });
});

test("real browser authentication, CSRF rejection, Session expiry and login throttling", async ({ page, request }) => {
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
  const sqlite = new DatabaseSync(database);
  try {
    sqlite.exec("PRAGMA busy_timeout=5000");
    sqlite.prepare("UPDATE sessions SET expiresAt = 0").run();
  } finally { sqlite.close(); }
  const expired = await page.context().request.get(`${origin}/api/auth/me`);
  expect(expired.status()).toBe(401);
  expect((await expired.json()).error.code).toBe("UNAUTHORIZED");
  await page.goto(`${origin}/chat`);
  await expect(page).toHaveURL(`${origin}/login`);
  await page.goto(`${origin}/knowledge`);
  await expect(page).toHaveURL(`${origin}/login`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(email);
  await page.getByPlaceholder("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
  expect((await page.context().request.post(`${origin}/api/auth/logout`)).ok()).toBe(true);
  expect((await page.context().request.get(`${origin}/api/auth/me`)).status()).toBe(401);
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
