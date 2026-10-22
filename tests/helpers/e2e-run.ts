import { randomUUID } from "node:crypto";
import { rmSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";

/** Inherited by workers so reloading the config cannot create another workspace. */
export async function getE2ERun(environment: Partial<NodeJS.ProcessEnv> = process.env) {
  const inheritedId = environment.RIA_E2E_RUN_ID;
  const inheritedPort = environment.RIA_E2E_PORT;
  if (inheritedId !== undefined || inheritedPort !== undefined) {
    if (!/^e2e-[a-f0-9-]{36}$/.test(inheritedId ?? "") ||
      !/^\d+$/.test(inheritedPort ?? "") || Number(inheritedPort) < 1 || Number(inheritedPort) > 65535) {
      throw new Error("Invalid E2E run identity or port; both must come from the parent test run.");
    }
  } else {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    environment.RIA_E2E_RUN_ID = `e2e-${randomUUID()}`;
    environment.RIA_E2E_PORT = String(port);
  }
  const id = environment.RIA_E2E_RUN_ID!;
  const port = Number(environment.RIA_E2E_PORT);
  const directory = resolve(".desktop-data/test", id);
  return {
    id, port, directory,
    origin: `http://localhost:${port}`,
    storageState: resolve(directory, "storage-state.json"),
    resultsDirectory: resolve("test-results", id),
    reportDirectory: resolve("playwright-report", id),
  };
}

/**
 * Removes a run's workspace (database, media, storage state). Failure evidence
 * lives in `test-results/` and `playwright-report/`, so nothing is kept here.
 * Runs inside a process `exit` handler, so it must stay synchronous.
 */
export function removeE2EWorkspace(directory: string) {
  if (dirname(directory) !== resolve(".desktop-data/test") || !/^e2e-[a-f0-9-]{36}$/.test(basename(directory))) {
    throw new Error(`Refusing to remove an unexpected E2E workspace: ${directory}`);
  }
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    writeSync(2, `Could not remove E2E workspace ${directory}: ${(error as Error).message}\n`);
  }
}
