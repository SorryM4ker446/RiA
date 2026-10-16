import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { createTempDirectory } from "../helpers/temp-directory";

test("a failed isolated server exposes redacted startup evidence and attaches it before cleanup", async ({}, info) => {
  const { root, remove } = createTempDirectory("ria-server-diagnostics-");
  try {
    const entry = join(root, "failed-server.cjs");
    writeFileSync(entry, `
      process.stderr.write('API_KEY=sk-diagnostics-fixture\\n');
      process.stderr.write('server bootstrap fixture failed\\n');
      process.exitCode = 7;
    `);
    let failure: unknown;
    try { await startStandaloneServer({ serverEntry: entry }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("code 7");
    expect(String(failure)).toContain("server bootstrap fixture failed");
    expect(String(failure)).not.toContain("sk-diagnostics-fixture");
    const logs = info.attachments.filter(attachment => attachment.name === "standalone-server-log");
    expect(logs.length).toBeGreaterThan(0);
    const text = logs.map(log => readFileSync(log.path!, "utf8")).join("\n");
    expect(text).toContain("server bootstrap fixture failed");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("sk-diagnostics-fixture");
  } finally { remove(); }
});
