import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { TEST_ACCESS_TOKEN } from "./workspace-entry";
import { createDesktopLogger, createDesktopLogSink } from "../../electron/logger";


type ProviderCall = { stream: boolean; messages: Array<{ role: string; content: unknown }> };

export async function startStandaloneServer(options: { modelFixture?: boolean; desktopScheduler?: boolean; serverEntry?: string } = {}) {
  const parent = resolve(".desktop-data/test");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "http-"));
  const database = join(root, "app.db");
  const logFile = join(root, "server.log");
  const logger = createDesktopLogger(logFile, { maxBytes: 256 * 1024, backupCount: 1 });
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  // The service is bound to 127.0.0.1 but reached as `localhost`, because that
  // is the origin the application resolves for its own requests. A cookie stored
  // for one name is never sent to the other, so the whole harness must agree.
  const origin = `http://localhost:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", APP_RUNTIME: options.desktopScheduler ? "desktop" : "test", APP_ORIGIN: "",
    // The harness must present the same credential the page will use.
    LOCAL_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
    DESKTOP_SERVER_HOST: options.desktopScheduler ? `localhost:${port}` : "",
    DESKTOP_SESSION_TOKEN: options.desktopScheduler ? TEST_ACCESS_TOKEN : "",
    HOSTNAME: "127.0.0.1", PORT: String(port), LOCAL_DATABASE_FILE: database,
    DATABASE_URL: `file:${database.replaceAll("\\", "/")}`, MEDIA_DIRECTORY: join(root, "media"), LEGACY_VIDEO_DIRECTORY: join(root, "legacy-videos"),
    OPENROUTER_API_KEY: options.modelFixture ? "offline-fixture-placeholder" : "", DEEPSEEK_API_KEY: "", TAVILY_API_KEY: "", TAVILY_SEARCH_URL: "",
    OUTBOUND_PROXY_URL: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
    PRIVATE_AI_HTTP_FIXTURE: options.modelFixture ? "1" : "0",
  };
  let server: ChildProcess | undefined;
  const providerCalls: ProviderCall[] = [];

  async function attachLogs() {
    for (const file of [logFile, `${logFile}.1`]) {
      if (existsSync(file)) await test.info().attach("standalone-server-log", { path: file, contentType: "text/plain" });
    }
  }

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
    const entry = options.serverEntry ?? ".desktop-runtime/server.js";
    const args = options.desktopScheduler
      ? [entry]
      : ["--import", pathToFileURL(resolve("tests/helpers/offline-http.ts")).href, entry];
    server = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    server.stdout?.pipe(createDesktopLogSink(logger, "server stdout"));
    server.stderr?.pipe(createDesktopLogSink(logger, "server stderr"));
    server.once("error", error => { launchError = true; logger.error("Server launch failed", error); });
    server.on("message", (value) => {
      const call = value as ProviderCall & { type?: string };
      if (call.type === "provider-call" && providerCalls.length < 100) providerCalls.push(call);
    });
    await expect.poll(async () => {
      if (launchError || server?.exitCode !== null || server?.signalCode !== null) {
        const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-8_000) : "No server log was produced.";
        throw new Error(`Isolated test server exited before readiness (code ${server?.exitCode}, signal ${server?.signalCode}).\n${tail}`);
      }
      return fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.status).catch(() => 0);
    }, { timeout: 30_000 }).toBe(200);
  }
  async function close() {
    try { await stop(); } catch (error) { await attachLogs(); throw error; }
    if (test.info().status !== test.info().expectedStatus) await attachLogs();
    if (dirname(root) !== parent) throw new Error("Unexpected standalone test directory");
    rmSync(root, { recursive: true, force: true });
  }
  try {
    execFileSync(process.execPath, ["scripts/run-with-local-db.mjs", "--migrate", "node", "--version"], { env, windowsHide: true, timeout: 30_000, stdio: "pipe" });
    await start();
  } catch (error) {
    await stop();
    await attachLogs();
    if (dirname(root) !== parent) throw new Error("Unexpected standalone test directory");
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    origin, providerCalls, close,
    async restart(prepare?: () => void) { await stop(); prepare?.(); await start(); },
    readRows(sql: string, ...parameters: Array<string | number>) {
      const sqlite = new DatabaseSync(database, { readOnly: true });
      try {
        sqlite.exec("PRAGMA busy_timeout=5000");
        return sqlite.prepare(sql).all(...parameters);
      } finally { sqlite.close(); }
    },
  };
}
