import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { createDesktopLogSink, type DesktopLogger } from "./logger";

export type NextServerOptions = {
  packagedRuntime: boolean;
  projectRoot: string;
  runtimeDirectory: string;
  serverEntry: string;
  nodeExecutable: string;
  databaseUrl: string;
  mediaDirectory: string;
  desktopSessionToken: string;
  port: number;
  environment: Record<string, string>;
  logger: DesktopLogger;
  /**
   * Abandons the launch and stops the child.
   *
   * The child is a separate operating system process from the first moment it
   * is spawned, and `startNextServer` only resolves once the service answers.
   * A caller that gives up in between — the shell quitting during a restart —
   * therefore has to say so, or the launch finishes into a process nothing is
   * left holding.
   */
  signal?: AbortSignal;
  /**
   * Told when a service that was ready stops answering because its process is
   * gone.
   *
   * A stop the caller asked for is not one of these, and neither is a launch
   * that never became ready: `startNextServer` is already failing for that one.
   */
  onUnexpectedExit?: (exit: NextServerExit) => void;
};

/** A service that was ready and then stopped, and the process it was. */
export type NextServerExit = {
  child: ChildProcess;
  code: number | null;
  signal: NodeJS.Signals | null;
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

export function launchCancelledError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const detail = reason === undefined ? "aborted" : reason instanceof Error ? reason.message : String(reason);
  return new Error(`Local Next.js service launch was cancelled: ${detail}`);
}

/** A sleep that gives up the moment the caller does, rather than at its own deadline. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(launchCancelledError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(launchCancelledError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForHealth(
  origin: string,
  child: ChildProcess,
  signal?: AbortSignal,
  timeoutMs = 90_000,
): Promise<void> {
  const startedAt = Date.now();
  let lastError = "No response";

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw launchCancelledError(signal);
    if (child.exitCode !== null) {
      throw new Error(`Local Next.js service exited before becoming ready (code ${child.exitCode}).`);
    }

    try {
      const response = await fetch(`${origin}/api/health`, {
        headers: { Accept: "application/json" },
        // A launch nobody is waiting for any more should also stop waiting on a
        // hung request, or the abort would not be noticed for up to two seconds.
        signal: signal ? AbortSignal.any([AbortSignal.timeout(2_000), signal]) : AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as { status?: string };
        if (payload.status === "ok") return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      if (signal?.aborted) throw launchCancelledError(signal);
      lastError = error instanceof Error ? error.message : String(error);
    }

    await pause(250, signal);
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
    DATABASE_URL: options.databaseUrl,
    MEDIA_DIRECTORY: options.mediaDirectory,
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
  // Checked before the spawn as well as after it: an abandoned launch must not
  // create the process it would then have to kill.
  if (options.signal?.aborted) throw launchCancelledError(options.signal);
  const child = spawn(command, args, {
    cwd: options.packagedRuntime ? options.runtimeDirectory : options.projectRoot,
    env: childEnvironment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(createDesktopLogSink(options.logger, "Next stdout"));
  child.stderr?.pipe(createDesktopLogSink(options.logger, "Next stderr"));

  /*
   * `stopping` is set before anything is signalled, so the exit a requested
   * stop causes is never reported as the service dying on its own. `ready`
   * keeps the two failures this function already reports out of it: a launch
   * that never became ready fails the health check instead.
   */
  let stopping = false;
  let ready = false;
  const stop = () => {
    stopping = true;
    return stopChild(child, options.logger);
  };
  child.once("error", (error) => options.logger.error("Local Next.js service process error", error));
  /*
   * Nothing else observes this process. The window keeps a document that stays
   * perfectly renderable without the service that produced it, and the IPC
   * trust checks compare an origin string a dead process still matches, so
   * without this the shell carries on pointing at a service that is gone and
   * every request to it fails without anything saying why.
   */
  child.once("exit", (code, signal) => {
    if (stopping || !ready) return;
    options.logger.error("The local Next.js service exited unexpectedly", { code, signal });
    options.onUnexpectedExit?.({ child, code, signal });
  });

  try {
    await waitForHealth(origin, child, options.signal);
    // The health check can succeed in the same turn the caller gives up, so the
    // last word belongs to the caller: a launch nobody adopted must be stopped
    // rather than returned for someone else to look after.
    if (options.signal?.aborted) throw launchCancelledError(options.signal);
    // The same turn can carry the process away, and an `exit` already delivered
    // here would never be seen again. The handle is asked directly rather than
    // a dead process being handed back as a running service.
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Local Next.js service exited while becoming ready (code ${child.exitCode}).`);
    }
    ready = true;
    options.logger.info("Local Next.js service is ready", { origin });
    return { child, origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
