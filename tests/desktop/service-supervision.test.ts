import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesktopLogger } from "../../electron/logger";
import { findAvailablePort, startNextServer, type NextServerExit } from "../../electron/next-server";

/*
 * The embedded service is a separate process, and nothing else in the shell can
 * tell that it has gone: a document that is already loaded keeps rendering, the
 * IPC trust checks compare an origin string a dead process still matches, and
 * the reminder poller only learns by failing. These tests drive
 * `startNextServer` with real child processes and watch the two things that are
 * supposed to happen when one of them stops existing — the caller is told, and
 * the log says so — and that a stop the caller asked for is not mistaken for
 * either.
 */

type LogEntry = { level: string; message: string; details: unknown };

function recordingLogger(): { entries: LogEntry[]; logger: DesktopLogger } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (message: string, details?: unknown) => {
    entries.push({ level, message, details });
  };
  return {
    entries,
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
  };
}

function unexpectedExits(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.message.includes("exited unexpectedly"));
}

/** Resolves from the caller's own callback, and fails the test if it never comes. */
function reportedExit(timeoutMs = 15_000): { promise: Promise<NextServerExit[]>; record: (exit: NextServerExit) => void } {
  const exits: NextServerExit[] = [];
  let record: (exit: NextServerExit) => void = () => {};
  const promise = new Promise<NextServerExit[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The service never reported that it had stopped.")), timeoutMs);
    record = (exit) => {
      clearTimeout(timer);
      exits.push(exit);
      resolve(exits);
    };
  });
  return { promise, record };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Answers its health check, and stops answering some time after that. */
const dyingWorker = `
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
  server.listen(Number(process.env.PORT), "127.0.0.1", () => {
    setTimeout(() => process.exit(Number(process.env.DESKTOP_TEST_EXIT_CODE)), 1500);
  });
`;

/** Stops before it ever answers, which is a failed launch rather than a death. */
const shortLivedWorker = `
  process.exit(Number(process.env.DESKTOP_TEST_EXIT_CODE));
`;

function writeWorker(root: string, name: string, body: string): string {
  const file = join(root, `${name}.cjs`);
  writeFileSync(file, body);
  return file;
}

function serverOptions(
  root: string,
  serverEntry: string,
  port: number,
  logger: DesktopLogger,
  onUnexpectedExit: (exit: NextServerExit) => void,
  exitCode: string,
) {
  return {
    packagedRuntime: true,
    projectRoot: root,
    runtimeDirectory: root,
    serverEntry,
    nodeExecutable: process.execPath,
    databaseUrl: `file:${join(root, "desktop.db").replace(/\\/g, "/")}`,
    mediaDirectory: root,
    desktopSessionToken: "desktop-service-supervision",
    port,
    environment: { DESKTOP_TEST_EXIT_CODE: exitCode },
    logger,
    onUnexpectedExit,
  };
}

test("a service that dies after becoming ready is reported and logged", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-service-supervision-"));
  try {
    const worker = writeWorker(root, "dying", dyingWorker);
    const port = await findAvailablePort();
    const { entries, logger } = recordingLogger();
    const { promise, record } = reportedExit();

    await startNextServer(serverOptions(root, worker, port, logger, record, "7"));
    const exits = await promise;

    assert.equal(exits.length, 1, "a service that stopped was reported more than once");
    assert.equal(exits[0].code, 7, "the exit was not reported with the code the service died of");
    assert.equal(exits[0].child.exitCode, 7, "the reported exit did not describe the child that died");
    const logged = unexpectedExits(entries);
    assert.deepEqual(logged.map((entry) => entry.level), ["error"], "a service that died was not logged as an error");
    assert.deepEqual(logged[0].details, { code: 7, signal: null }, "the log did not say how the service stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a service stopped on request is not reported as an unexpected exit", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-service-supervision-stop-"));
  try {
    const worker = writeWorker(root, "stopped", listeningWorker);
    const port = await findAvailablePort();
    const { entries, logger } = recordingLogger();
    const exits: NextServerExit[] = [];
    const running = await startNextServer(serverOptions(root, worker, port, logger, (exit) => exits.push(exit), "0"));

    await running.stop();
    assert.ok(running.child.exitCode !== null || running.child.signalCode !== null, "the stop left the process running");
    // The exit an application asked for arrives on the same event as one it did
    // not, so the check has to outlast the stop rather than race it.
    await settle(1_500);

    assert.deepEqual(exits.map((exit) => exit.code), [], "stopping a service reported it as having died on its own");
    assert.deepEqual(unexpectedExits(entries), [], "stopping a service wrote a death into the desktop log");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a service that stops before it is ready is a failed launch, not a death", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "private-ai-service-supervision-early-"));
  try {
    const worker = writeWorker(root, "short-lived", shortLivedWorker);
    const port = await findAvailablePort();
    const { entries, logger } = recordingLogger();
    const exits: NextServerExit[] = [];

    await assert.rejects(
      startNextServer(serverOptions(root, worker, port, logger, (exit) => exits.push(exit), "3")),
      /exited before becoming ready \(code 3\)/,
    );
    await settle(1_000);

    assert.deepEqual(exits.map((exit) => exit.code), [], "a launch that never became ready was reported as a service that died");
    assert.deepEqual(unexpectedExits(entries), [], "a failed launch was logged as a service that died");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
