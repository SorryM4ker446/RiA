import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { desktopServiceEnvironment } from "../../electron/next-server";

const settings = { OPENROUTER_API_KEY: "", DEEPSEEK_API_KEY: "", OUTBOUND_PROXY_URL: "", OPENROUTER_SITE_NAME: "RiA Desktop" };

test("provider keys and the proxy left empty in Settings stay empty for the service", () => {
  const environment = desktopServiceEnvironment(settings);
  for (const key of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "OUTBOUND_PROXY_URL"]) assert.equal(environment[key], "", key);
  assert.equal(desktopServiceEnvironment({ ...settings, OPENROUTER_API_KEY: "saved-in-settings" }).OPENROUTER_API_KEY, "saved-in-settings");
});

test("an empty key passed to the service is not filled in from the project's .env", () => {
  const directory = mkdtempSync(join(tmpdir(), "ria-service-env-"));
  try {
    // Placeholder values; the point is which source wins, not what they are.
    writeFileSync(join(directory, ".env"), "OPENROUTER_API_KEY=placeholder-from-dotenv\nRIA_ENV_PROBE=loaded\n");
    const nextEnv = createRequire(join(process.cwd(), "package.json")).resolve("@next/env");
    const script = `const { loadEnvConfig } = require(${JSON.stringify(nextEnv)}); loadEnvConfig(${JSON.stringify(directory)}, true, { info() {}, error() {} }); process.stdout.write(JSON.stringify({ key: process.env.OPENROUTER_API_KEY ?? null, probe: process.env.RIA_ENV_PROBE ?? null }));`;
    const run = (environment: NodeJS.ProcessEnv) => {
      const result = spawnSync(process.execPath, ["-e", script], { env: environment, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as { key: string | null; probe: string | null };
    };
    const base = { ...process.env };
    delete base.OPENROUTER_API_KEY;
    // The file is read either way; an empty value from the shell is kept.
    assert.deepEqual(run({ ...base, OPENROUTER_API_KEY: "" }), { key: "", probe: "loaded" });
    // Leaving the variable out is what let the file supply a key Settings did not show.
    assert.deepEqual(run(base), { key: "placeholder-from-dotenv", probe: "loaded" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
