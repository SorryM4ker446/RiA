import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesktopLogger } from "../../electron/logger";
import { findAvailablePort, startNextServer } from "../../electron/next-server";

/*
 * The embedded service is a separate operating system process, and the shell
 * does not take it down with it. These tests drive `startNextServer` with real
 * child processes — including the shape `next dev` actually has, a launcher
 * that forks the worker holding the port — so that anything left running after
 * a launch or a stop is visible as a live process rather than inferred.
 */

function quietLogger(): DesktopLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function canConnect(port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise<boolean>((settle) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (reachable: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      settle(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordedWorkerPid(root: string): number {
  try {
    return Number(readFileSync(join(root, "worker.pid"), "utf8").trim());
  } catch {
    return 0;
  }
}

async function waitUntilGone(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await check())) return true;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return !(await check());
}

/**
 * Kills whatever a fixture left running, independently of the code under test,
 * so a failing assertion cannot leak a process into the rest of the run.
 */
function killRecordedWorker(root: string): void {
  const pid = recordedWorkerPid(root);
  if (pid > 0) {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }
}

function writeWorker(root: string, body: string): string {
  const file = join(root, "worker.cjs");
  writeFileSync(file, `
    const fs = require("node:fs");
    const path = require("node:path");
    fs.writeFileSync(path.join(__dirname, "worker.pid"), String(process.pid));
    ${body}
  `);
  return file;
}

function writeLauncher(root: string, worker: string): string {
  const file = join(root, "launcher.cjs");
  /*
   * `next dev` is a launcher that forks the worker which listens on the port,
   * and this reproduces that shape, so a worker left behind shows up here as a
   * process that is still alive rather than as a symptom further downstream.
   */
  writeFileSync(file, `
    const fs = require("node:fs");
    const path = require("node:path");
    fs.writeFileSync(path.join(__dirname, "launcher.pid"), String(process.pid));
    const { fork } = require("node:child_process");
    const worker = fork(${JSON.stringify(worker)}, { stdio: "inherit" });
    const forward = () => { try { worker.kill("SIGKILL"); } catch {} };
    process.on("SIGTERM", () => { forward(); process.exit(0); });
    process.on("SIGINT", () => { forward(); process.exit(0); });
    process.on("exit", forward);
    setInterval(() => {}, 1 << 30);
  `);
  return file;
}

function serverOptions(
  root: string,
  serverEntry: string,
  port: number,
  logger: DesktopLogger,
  signal?: AbortSignal,
  environment: Record<string, string> = {},
) {
  return {
    packagedRuntime: true,
    projectRoot: root,
    runtimeDirectory: root,
    serverEntry,
    nodeExecutable: process.execPath,
    databaseUrl: `file:${join(root, "desktop.db").replace(/\\/g, "/")}`,
    mediaDirectory: root,
    desktopSessionToken: "desktop-final-fixes",
    port,
    environment,
    logger,
    signal,
  };
}

const listeningWorker = `
  const http = require("node:http");
  const server = http.createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(Number(process.env.PORT), "127.0.0.1");
  setInterval(() => {}, 1 << 30);
`;

// Remains in startup until cancelled, independently of the machine's speed.
const waitingWorker = `setInterval(() => {}, 1 << 30);`;

test("an abandoned launch is stopped instead of finishing into an unsupervised service", {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-service-abandoned-"));
  const abort = new AbortController();
  let launch: ReturnType<typeof startNextServer> | undefined;
  try {
    const launcher = writeLauncher(root, writeWorker(root, waitingWorker));
    const port = await findAvailablePort();

    /*
     * The shell quitting mid-restart: the launch is still booting, so the child
     * exists but nothing has adopted it. Giving up has to stop that child rather
     * than hand it to a caller that walked away, or it outlives the application
     * holding the port and the database.
     */
    launch = startNextServer(
      serverOptions(root, launcher, port, quietLogger(), abort.signal),
    );
    // Observe early launch failures without leaving an unhandled rejection.
    void launch.catch(() => {});
    assert.equal(await waitUntilGone(() => recordedWorkerPid(root) === 0), true,
      "the fixture worker must exist before cancellation is exercised");

    const workerPid = recordedWorkerPid(root);
    const launcherPid = Number(readFileSync(join(root, "launcher.pid"), "utf8"));
    assert.ok(isProcessAlive(workerPid), "the fixture worker must still be running");
    assert.equal(await canConnect(port), false, "the fixture must still be starting");
    abort.abort(new Error("The application is quitting."));
    await assert.rejects(launch, /cancelled: The application is quitting\./);
    assert.equal(
      await waitUntilGone(() => isProcessAlive(workerPid)),
      true,
      "the cancelled launch left its process running after the caller gave up",
    );
    assert.equal(await waitUntilGone(() => isProcessAlive(launcherPid)), true,
      "the cancelled launch left its launcher running");
    assert.equal(await canConnect(port), false);
  } finally {
    abort.abort(new Error("The application is quitting."));
    // Settle startup before removing files, including when a readiness check fails.
    const running = await launch?.catch(() => undefined);
    await running?.stop();
    killRecordedWorker(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already-abandoned launch starts no process at all", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-service-preabort-"));
  try {
    const launcher = writeLauncher(root, writeWorker(root, listeningWorker));
    const port = await findAvailablePort();
    const abort = new AbortController();
    abort.abort(new Error("The application is quitting."));

    await assert.rejects(
      startNextServer(serverOptions(root, launcher, port, quietLogger(), abort.signal)),
      /cancelled: The application is quitting\./,
    );
    assert.equal(await canConnect(port), false, "an already-abandoned launch started a service anyway");
    assert.equal(recordedWorkerPid(root), 0, "an already-abandoned launch spawned a process anyway");
  } finally {
    killRecordedWorker(root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a port a running service already holds is never offered as available", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-service-port-"));
  try {
    const launcher = writeLauncher(root, writeWorker(root, listeningWorker));
    const port = await findAvailablePort();
    const running = await startNextServer(serverOptions(root, launcher, port, quietLogger()));
    try {
      assert.equal(await canConnect(port), true, "the fixture service should be listening");
      assert.notEqual(
        await findAvailablePort(),
        port,
        "findAvailablePort handed out a port a leftover service of this application is still listening on",
      );
    } finally {
      await running.stop();
      killRecordedWorker(root);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
