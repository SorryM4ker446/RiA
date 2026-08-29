import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { DesktopLogger } from "./logger";

export type NextServerOptions = {
  packagedRuntime: boolean;
  projectRoot: string;
  runtimeDirectory: string;
  serverEntry: string;
  nodeExecutable: string;
  databaseUrl: string;
  desktopSessionToken: string;
  port: number;
  logFile: string;
  environment: Record<string, string>;
  logger: DesktopLogger;
};

export type RunningNextServer = {
  child: ChildProcess;
  origin: string;
  stop: () => Promise<void>;
};

export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(origin: string, child: ChildProcess, timeoutMs = 90_000): Promise<void> {
  const startedAt = Date.now();
  let lastError = "No response";

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Local Next.js service exited before becoming ready (code ${child.exitCode}).`);
    }

    try {
      const response = await fetch(`${origin}/api/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as { status?: string };
        if (payload.status === "ok") return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for the local Next.js service: ${lastError}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function stopChild(child: ChildProcess, logger: DesktopLogger): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;

  logger.warn("Local Next.js service did not exit gracefully; terminating its process tree", {
    pid: child.pid,
  });
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 3_000);
}

export async function startNextServer(options: NextServerOptions): Promise<RunningNextServer> {
  const host = `127.0.0.1:${options.port}`;
  const origin = `http://${host}`;
  const logDescriptor = openSync(options.logFile, "a");
  const command = options.packagedRuntime ? process.execPath : options.nodeExecutable;
  const args = options.packagedRuntime
    ? [options.serverEntry]
    : [
        join(options.projectRoot, "node_modules", "next", "dist", "bin", "next"),
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(options.port),
      ];
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.environment,
    NODE_ENV: options.packagedRuntime ? "production" : "development",
    APP_RUNTIME: "desktop",
    AUTH_DISABLED: "1",
    DATABASE_URL: options.databaseUrl,
    DESKTOP_SESSION_TOKEN: options.desktopSessionToken,
    DESKTOP_SERVER_HOST: host,
    HOSTNAME: "127.0.0.1",
    PORT: String(options.port),
    NO_PROXY: "localhost,127.0.0.1,::1",
    ...(options.packagedRuntime ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };

  options.logger.info("Starting local Next.js service", {
    mode: options.packagedRuntime ? "standalone" : "development",
    origin,
  });
  const child = spawn(command, args, {
    cwd: options.packagedRuntime ? options.runtimeDirectory : options.projectRoot,
    env: childEnvironment,
    windowsHide: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);

  const stop = () => stopChild(child, options.logger);
  child.once("error", (error) => options.logger.error("Local Next.js service process error", error));

  try {
    await waitForHealth(origin, child);
    options.logger.info("Local Next.js service is ready", { origin });
    return { child, origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
