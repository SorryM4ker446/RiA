import { expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

type ProviderCall = { stream: boolean; messages: Array<{ role: string; content: unknown }> };

export async function startStandaloneServer(options: { modelFixture?: boolean } = {}) {
  const parent = resolve(".desktop-data/test");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "http-"));
  const database = join(root, "app.db");
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", APP_RUNTIME: "test", AUTH_DISABLED: "0", APP_ORIGIN: "",
    HOSTNAME: "127.0.0.1", PORT: String(port), LOCAL_DATABASE_FILE: database,
    DATABASE_URL: `file:${database.replaceAll("\\", "/")}`, MEDIA_DIRECTORY: join(root, "media"), LEGACY_VIDEO_DIRECTORY: join(root, "legacy-videos"),
    OPENROUTER_API_KEY: options.modelFixture ? "offline-fixture-placeholder" : "", TAVILY_API_KEY: "", TAVILY_SEARCH_URL: "",
    OUTBOUND_PROXY_URL: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
    PRIVATE_AI_HTTP_FIXTURE: options.modelFixture ? "1" : "0",
  };
  let server: ChildProcess | undefined;
  const providerCalls: ProviderCall[] = [];

  async function stop() {
    if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
    const child = server;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Test server did not stop; isolated data retained")), 10_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.kill();
    });
  }
  async function start() {
    let launchError = false;
    server = spawn(process.execPath, ["--import", pathToFileURL(resolve("tests/helpers/offline-http.mjs")).href, ".desktop-runtime/server.js"], { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    server.once("error", () => { launchError = true; });
    server.on("message", (value) => {
      const call = value as ProviderCall & { type?: string };
      if (call.type === "provider-call" && providerCalls.length < 100) providerCalls.push(call);
    });
    await expect.poll(async () => {
      if (launchError || server?.exitCode !== null) throw new Error("Isolated test server exited before readiness");
      return fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.status).catch(() => 0);
    }, { timeout: 30_000 }).toBe(200);
  }
  async function close() {
    await stop();
    if (dirname(root) !== parent) throw new Error("Unexpected standalone test directory");
    rmSync(root, { recursive: true, force: true });
  }
  try {
    execFileSync(process.execPath, ["scripts/run-with-local-db.mjs", "--migrate", "node", "--version"], { env, windowsHide: true, timeout: 30_000, stdio: "pipe" });
    await start();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    origin, providerCalls, close,
    async restart() { await stop(); await start(); },
    readRows(sql: string, ...parameters: Array<string | number>) {
      const sqlite = new DatabaseSync(database, { readOnly: true });
      try {
        sqlite.exec("PRAGMA busy_timeout=5000");
        return sqlite.prepare(sql).all(...parameters);
      } finally { sqlite.close(); }
    },
    expireSessions() {
      const sqlite = new DatabaseSync(database);
      try {
        sqlite.exec("PRAGMA busy_timeout=5000");
        sqlite.prepare("UPDATE sessions SET expiresAt = 0").run();
      } finally { sqlite.close(); }
    },
  };
}
