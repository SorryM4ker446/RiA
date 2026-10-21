import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { db } from "@/db";
import { resolveGrant } from "@/lib/local-files/safe-path";
import { ApiError } from "@/lib/server/api-error";
import { encodedPowerShellCommand } from "./powershell";
import { captureFileSnapshot, compareFileSnapshots } from "./file-changes";
import { openTerminalLog, type TerminalLogWriter } from "./logs";
import { TERMINAL_LIMITS, terminalInputSchema, terminalRuntimeAllowed, type TerminalInput, type TerminalSessionView } from "./schema";

type Session = { view: TerminalSessionView; runId?: string | null; stop: () => void };
const state = globalThis as typeof globalThis & { __riaTerminalSessions?: Map<string, Session> };
const sessions = () => state.__riaTerminalSessions ??= new Map();
const refuse = (message: string) => new ApiError({ code: "FORBIDDEN", message });

export async function terminalGrant(grantId: string) {
  if (!terminalRuntimeAllowed()) throw refuse("终端工具仅在 Windows 桌面应用中可用。");
  const grant = await db.directoryGrant.findUnique({ where: { id: grantId } });
  if (!grant || grant.revokedAt || !grant.terminalEnabled) throw refuse("此目录尚未开启终端权限，或权限已撤销。");
  const resolved = await resolveGrant({ label: grant.label, path: grant.path });
  if (resolved.isFile || resolved.realPath !== grant.realPath || !(await stat(resolved.realPath)).isDirectory()) throw refuse("终端工作目录已变化，请重新授权。");
  return grant;
}

export async function bindTerminalApproval(input: unknown) {
  const parsed = terminalInputSchema.parse(input);
  const grant = await terminalGrant(parsed.grantId);
  if (parsed.binding && (parsed.binding.grantId !== grant.id || parsed.binding.revision !== grant.updatedAt.toISOString() || parsed.binding.cwd !== grant.realPath)) throw refuse("终端授权或工作目录已变化，请重新提出命令。");
  const binding = parsed.binding ?? { sessionId: randomUUID(), grantId: grant.id, revision: grant.updatedAt.toISOString(), cwd: grant.realPath };
  Object.assign(input as object, { ...parsed, binding });
  return { ...parsed, binding };
}

function pruneSessions(reserveSlot = false) {
  for (const [id, session] of sessions()) {
    if (session.view.finishedAt && Date.now() - Date.parse(session.view.finishedAt) > TERMINAL_LIMITS.retentionMs) sessions().delete(id);
  }
  while (sessions().size > TERMINAL_LIMITS.retainedSessions - Number(reserveSlot)) {
    const oldest = [...sessions()].find(([, value]) => value.view.status !== "running");
    if (!oldest) break;
    sessions().delete(oldest[0]);
  }
}

export function getTerminalSession(id: string): TerminalSessionView {
  if (!terminalRuntimeAllowed()) throw refuse("终端工具仅在 Windows 桌面应用中可用。");
  pruneSessions();
  const session = sessions().get(id);
  if (!session) throw new ApiError({ code: "NOT_FOUND", message: "此终端记录已结束或服务已重启，请查看聊天中保存的结果。" });
  return { ...session.view };
}

export function stopTerminalSession(id: string) {
  getTerminalSession(id);
  sessions().get(id)!.stop();
  return getTerminalSession(id);
}
/** Commands still running, whose logs are being written. */
export const activeTerminalSessionIds = () => [...sessions().values()].filter(session => session.view.status === "running").map(session => session.view.id);
export function stopTerminalCommandsForGrant(grantId: string) {
  for (const session of sessions().values()) if (session.view.grantId === grantId) session.stop();
}
export function stopTerminalCommandsForRun(runId: string) {
  for (const session of sessions().values()) if (session.runId === runId) session.stop();
}

export function terminalEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Inherit executable discovery and development-tool locations, rather than
  // the service's credentials, Node preload options or production-only mode.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|HOME|LANG|LC_ALL|PSMODULEPATH|GOROOT|GOPATH|GOBIN|GOCACHE|GOMODCACHE|GOENV|GOWORK|GOTOOLCHAIN|PYTHONHOME|PYTHONPATH|PYTHONIOENCODING|PYTHONUTF8|PYTHONNOUSERSITE|VIRTUAL_ENV|CONDA_PREFIX|CONDA_DEFAULT_ENV|CONDA_EXE|PYENV_ROOT|PYENV_HOME|PYENV_VERSION|NODE_PATH|NODE_EXTRA_CA_CERTS|NVM_HOME|NVM_SYMLINK|VOLTA_HOME|NPM_CONFIG_PREFIX|NPM_CONFIG_CACHE|COREPACK_HOME|JAVA_HOME|JDK_HOME|DOTNET_ROOT|DOTNET_ROOT_X64|CARGO_HOME|RUSTUP_HOME|RUSTUP_TOOLCHAIN)$/i;
  // Next augments ProcessEnv with a required NODE_ENV for its own service;
  // an ordinary child process can correctly omit it.
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => allowed.test(key) && value !== undefined)) as NodeJS.ProcessEnv;
}

export async function runTerminalCommand(raw: TerminalInput, signal?: AbortSignal, runId?: string | null): Promise<TerminalSessionView> {
  const input = terminalInputSchema.parse(raw);
  const binding = input.binding;
  if (!binding || binding.grantId !== input.grantId) throw refuse("终端命令尚未确认。");
  pruneSessions(true);
  if (sessions().has(binding.sessionId)) throw new ApiError({ code: "CONFLICT", message: "此终端命令已经执行，请重新提出命令。" });
  if ([...sessions().values()].filter(session => session.view.status === "running").length >= TERMINAL_LIMITS.concurrent) throw new ApiError({ code: "RATE_LIMITED", message: "最多同时运行两个终端命令，请等待或停止现有命令。" });
  let child: ChildProcess | undefined;
  let stopping: "stopped" | null = null;
  let logWriter: TerminalLogWriter | null = null, logOpening: Promise<void> | null = null;
  // Close the log once, after the last output is appended, whatever the outcome.
  const closeLog = async (finished: boolean) => {
    await logOpening;
    if (logWriter) { view.log = await logWriter.close(finished).catch(() => ({ ...logWriter!.reference(), complete: false })); logWriter = null; }
  };
  const view: TerminalSessionView = { id: binding.sessionId, grantId: input.grantId, command: input.command, cwd: binding.cwd, shell: process.platform === "win32" ? "Windows PowerShell" : "sh (test)", status: "running", stdout: "", stderr: "", truncated: false, exitCode: null, startedAt: new Date().toISOString(), finishedAt: null };
  const stop = () => {
    if (view.status !== "running" || stopping) return;
    stopping = "stopped";
    if (!child?.pid) return;
    if (process.platform === "win32") { if (child.exitCode === null && child.signalCode === null) child.kill(); }
    else { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
  };
  sessions().set(view.id, { view, stop, runId });
  const abort = () => stop();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const grant = await terminalGrant(input.grantId);
    if (grant.realPath !== binding.cwd || grant.updatedAt.toISOString() !== binding.revision) throw refuse("终端授权或工作目录已变化，请重新提出并确认命令。");
    const run = runId ? await db.agentRun.findUnique({ where: { id: runId } }) : null;
    if (runId && (!run || !["running", "waiting_approval"].includes(run.status))) stopping = "stopped";
    if (signal?.aborted || stopping) {
      view.status = stopping ?? "stopped";
      view.finishedAt = new Date().toISOString();
      return { ...view };
    }
    const beforeFiles = await captureFileSnapshot(grant.realPath);
    if (signal?.aborted || stopping) {
      view.status = stopping ?? "stopped";
      return { ...view, finishedAt: new Date().toISOString() };
    }
    const command = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe") : "/bin/sh";
    const args = process.platform === "win32" ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShellCommand()] : ["-s"];
    const env = terminalEnvironment();
    // Send scripts through a pipe to avoid Windows environment and command-line
    // length limits. EOF leaves no interactive input for the executed command.
    child = spawn(command, args, { cwd: grant.realPath, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    if (process.platform !== "win32") child.once("exit", () => {
      // The test shell must not leave background children holding output pipes.
      try { process.kill(-child!.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("terminal.cleanup.failed"); }
    });
    // Keep the beginning and the most recent end of each stream in memory: the
    // end is where builds and test runners report their outcome. Once output
    // exceeds that, a log keeps all of it for reading back on demand.
    const headLimit = TERMINAL_LIMITS.outputBytes - 2 * TERMINAL_LIMITS.tailBytes;
    let headBytes = 0;
    const captured = { stdout: { head: "", tail: Buffer.alloc(0), omitted: 0 }, stderr: { head: "", tail: Buffer.alloc(0), omitted: 0 } };
    let pending: { field: "stdout" | "stderr"; text: string }[] | null = null;
    const render = (field: "stdout" | "stderr") => {
      const { head, tail, omitted } = captured[field];
      if (!omitted) return head;
      let start = 0;
      while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
      const shown = tail.subarray(start);
      const gap = omitted - shown.length;
      return head + (gap > 0 ? `\n… [${gap} bytes omitted from this capture] …\n` : "") + shown.toString("utf8");
    };
    const append = (field: "stdout" | "stderr", text: string) => {
      const clean = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (!clean) return;
      if (logWriter) logWriter.write(field, clean);
      else pending?.push({ field, text: clean });
      const bytes = Buffer.from(clean);
      const selected = bytes.subarray(0, Math.max(0, headLimit - headBytes));
      const decoder = new StringDecoder("utf8");
      const headText = decoder.write(selected);
      const headUsed = Buffer.byteLength(headText);
      if (headUsed < bytes.length && !view.truncated) {
        view.truncated = true;
        // Everything so far is still in the head, so the log starts complete.
        pending = [{ field, text: clean.slice(headText.length) }];
        const snapshot = { stdout: captured.stdout.head + (field === "stdout" ? headText : ""), stderr: captured.stderr.head + (field === "stderr" ? headText : "") };
        logOpening = openTerminalLog({ id: view.id, grantId: input.grantId, runId, ...snapshot, active: activeTerminalSessionIds() }).then(writer => {
          for (const item of pending ?? []) writer?.write(item.field, item.text);
          pending = null;
          logWriter = writer;
        }, () => { pending = null; });
      }
      captured[field].head += headText;
      headBytes += headUsed;
      const rest = bytes.subarray(headUsed);
      if (rest.length) {
        // Close the head, even with a few bytes left before a split character,
        // so later output can never be placed ahead of output already in a tail.
        headBytes = headLimit;
        captured[field].omitted += rest.length;
        const tail = Buffer.concat([captured[field].tail, rest]);
        captured[field].tail = tail.subarray(Math.max(0, tail.length - TERMINAL_LIMITS.tailBytes));
      }
      view[field] = render(field);
    };
    const stdout = new StringDecoder("utf8"), stderr = new StringDecoder("utf8");
    child.stdout!.on("data", data => append("stdout", stdout.write(data)));
    child.stderr!.on("data", data => append("stderr", stderr.write(data)));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", code => resolve(code));
      child!.stdin!.on("error", error => {
        // Stopping during transfer can close the pipe before all input is sent.
        if (!stopping) { stop(); reject(error); }
      });
      child!.stdin!.end(input.command, "utf8");
    });
    append("stdout", stdout.end()); append("stderr", stderr.end());
    await closeLog(true);
    view.exitCode = exitCode;
    view.status = stopping ?? (exitCode === 0 ? "completed" : "failed");
    try {
      const currentGrant = await db.directoryGrant.findUnique({ where: { id: input.grantId } });
      view.fileChanges = currentGrant && !currentGrant.revokedAt && currentGrant.terminalEnabled && currentGrant.updatedAt.toISOString() === binding.revision
        ? compareFileSnapshots(beforeFiles, await captureFileSnapshot(grant.realPath)) : { files: [], complete: false };
    } catch {
      // Missing change observations must not overwrite the command's actual result.
      view.fileChanges = { files: [], complete: false };
    }
    return { ...view, finishedAt: new Date().toISOString() };
  } catch (error) {
    view.status = stopping ?? "failed";
    await closeLog(false);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (view.status === "running") view.status = stopping ?? "failed";
    view.finishedAt = new Date().toISOString();
  }
}
