import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

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
