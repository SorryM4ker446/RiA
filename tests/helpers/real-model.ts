import { test as base, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { TEST_ACCESS_TOKEN, openWorkspace } from "./workspace-entry";
import { browserApi, browserData } from "./browser-api";

/*
 * Scenarios against a real model provider (`npm run test:real`).
 *
 * The provider, model and key come with each run (scripts/on-demand.mjs); none
 * of them is kept in the repository. Each scenario gets its own service with
 * its own database, the key in that service's environment only, and the model
 * added to its library and chosen for chat. What each scenario spent is read
 * from the application's own usage records, so it works for any provider; once
 * the run has spent more than its cap the remaining scenarios are skipped.
 */

const KEY_VARIABLES = { openrouter: "OPENROUTER_API_KEY", deepseek: "DEEPSEEK_API_KEY" } as const;
type Provider = keyof typeof KEY_VARIABLES;

export type Usage = { requests: number; inputTokens: number; outputTokens: number; costUsd: number; unknownCostRequests: number };
export type RealModel = {
  origin: string;
  provider: Provider;
  modelId: string;
  /** The model's usage in this scenario's service so far. */
  usage(page: Page): Promise<Usage>;
};

/** Spent by the scenarios of this run so far (they run one at a time, in one worker). */
const spent = { usd: 0, unknown: 0 };

function settings() {
  const provider = process.env.RIA_REAL_PROVIDER as Provider | undefined;
  const modelId = process.env.RIA_REAL_MODEL;
  const key = process.env.RIA_REAL_API_KEY;
  const maxUsd = Number(process.env.RIA_REAL_MAX_USD ?? "0.05");
  if (!provider || !(provider in KEY_VARIABLES) || !modelId || !key) throw new Error("Run real-model scenarios with `npm run test:real -- --provider <id> --model <id>`, which asks for the key.");
  return { provider, modelId, key, maxUsd };
}

async function startService(provider: Provider, key: string) {
  const parent = resolve(".desktop-data/test");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "real-"));
  const database = join(root, "app.db");
  const listener = createServer();
  await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(done => listener.close(() => done()));
  // Only what this service needs: the real key goes here and nowhere else.
  const { RIA_REAL_API_KEY: _key, ...inherited } = process.env;
  void _key;
  const env: NodeJS.ProcessEnv = {
    ...inherited, NODE_ENV: "production", NODE_OPTIONS: "", APP_RUNTIME: "test", APP_ORIGIN: "",
    LOCAL_ACCESS_TOKEN: TEST_ACCESS_TOKEN, DESKTOP_SERVER_HOST: "", DESKTOP_SESSION_TOKEN: "",
    HOSTNAME: "127.0.0.1", PORT: String(port), LOCAL_DATABASE_FILE: database,
    DATABASE_URL: `file:${database.replaceAll("\\", "/")}`, MEDIA_DIRECTORY: join(root, "media"), LEGACY_VIDEO_DIRECTORY: join(root, "legacy-videos"),
    OPENROUTER_API_KEY: "", DEEPSEEK_API_KEY: "", [KEY_VARIABLES[provider]]: key,
    RIA_HTTP_FIXTURE: "0", RIA_EXTENSION_KEY: randomBytes(32).toString("base64"),
  };
  execFileSync(process.execPath, ["scripts/run-with-local-db.mjs", "--migrate", "node", "--version"], { env, windowsHide: true, stdio: "pipe" });
  const server: ChildProcess = spawn(process.execPath, [".desktop-runtime/server.js"], { env, windowsHide: true, stdio: "ignore" });
  const origin = `http://localhost:${port}`;
  await expect.poll(() => fetch(`${origin}/api/health`).then(response => response.status).catch(() => 0), { timeout: 30_000 }).toBe(200);
  return {
    origin,
    async close() {
      server.kill();
      await new Promise(done => server.once("exit", done));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function readUsage(page: Page, origin: string): Promise<Usage> {
  const totals = (await browserData(page, `${origin}/api/usage`) as { totals: { requests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; unknownCostRequests: number } }).totals;
  return { requests: totals.requests, inputTokens: totals.inputTokens ?? 0, outputTokens: totals.outputTokens ?? 0, costUsd: totals.costUsd ?? 0, unknownCostRequests: totals.unknownCostRequests };
}

export const test = base.extend<{ real: RealModel }>({
  real: async ({ page }, runTest, info) => {
    const { provider, modelId, key, maxUsd } = settings();
    test.skip(spent.usd >= maxUsd, `The run has spent $${spent.usd.toFixed(4)}, at or over its $${maxUsd} cap.`);
    const service = await startService(provider, key);
    try {
      await openWorkspace(page, service.origin);
      const model = { providerId: provider, modelId };
      expect((await browserApi(page, `${service.origin}/api/models/catalog`, "POST", { providerId: provider, mode: "chat" })).status, "the provider's catalog could be read with this key").toBe(200);
      expect((await browserApi(page, `${service.origin}/api/models/library`, "POST", { action: "add", model })).status, `${modelId} is offered by ${provider}`).toBe(200);
      const preferences = (await browserApi(page, `${service.origin}/api/models`)).body.data;
      preferences.chat.model = model;
      expect((await browserApi(page, `${service.origin}/api/models`, "PUT", preferences)).status).toBe(200);
      await runTest({ origin: service.origin, provider, modelId, usage: target => readUsage(target, service.origin) });
    } finally {
      const usage = await readUsage(page, service.origin).catch(() => null);
      if (usage) {
        spent.usd += usage.costUsd;
        spent.unknown += usage.unknownCostRequests;
        const line = `${usage.requests} calls, ${usage.inputTokens} tokens in / ${usage.outputTokens} out, $${usage.costUsd.toFixed(5)}${usage.unknownCostRequests ? ` (+${usage.unknownCostRequests} calls of unknown cost)` : ""}; run so far $${spent.usd.toFixed(5)}`;
        console.log(`[${info.title}] ${line}`);
        await info.attach("usage", { body: line, contentType: "text/plain" });
      }
      await service.close();
    }
  },
});
export { expect };
