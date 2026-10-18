import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { asSchema } from "ai";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
const { bindTerminalApproval, runTerminalCommand, getTerminalSession, stopTerminalSession, terminalEnvironment } = await import("@/lib/terminal/runtime");
const { createChatToolSet } = await import("@/tools/catalog");
const { startRun, cancelRun } = await import("@/lib/agent/runs");
const { terminalInputSchema, TERMINAL_LIMITS } = await import("@/lib/terminal/schema");
const permissionRoute = await import("@/app/api/directory-grants/[id]/route");
const sessionsRoute = await import("@/app/api/terminal/sessions/[id]/route");
const manualRoute = await import("@/app/api/tools/run/route");
const { claimToolApproval } = await import("@/lib/chat/store");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const roots: string[] = [];
const win = process.platform === "win32";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (url: string, method = "GET", body?: unknown, cookie = localAccessCookie()) => new NextRequest(`http://localhost${url}`, {
  method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function folder(enabled = true) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-terminal-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  if (enabled) await setTerminalPermission(grant.id, true, grant.updatedAt);
  return (await listGrants()).find(row => row.id === grant.id)!;
}
const echo = win ? "[Console]::WriteLine('ready')" : "printf 'ready\\n'";
const long = win ? `${echo}; Start-Sleep -Seconds 30` : `${echo}; sleep 30`;
async function prepared(grantId: string, command = echo, timeoutSeconds = 20) {
  return bindTerminalApproval({ grantId, command, timeoutSeconds });
}
async function eventually(check: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("Terminal did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
beforeEach(async () => {
  process.env.APP_RUNTIME = "test";
  globalThis.__privateAiRateLimitStore?.clear();
});
after(async () => {
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== realpathSync.native(tmpdir()) || !path.basename(root).startsWith("ria-terminal-")) throw new Error("Unexpected terminal test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});

test("file grants do not enable the terminal; web runtimes and missing approval bindings are refused", async () => {
  const grant = await folder(false);
  assert.equal(grant.terminalEnabled, false);
  assert.equal((await createChatToolSet()).runTerminalCommand, undefined);
  await assert.rejects(prepared(grant.id), /终端权限/);
  await assert.rejects(runTerminalCommand(terminalInputSchema.parse({ grantId: grant.id, command: echo })), /尚未确认/);
  process.env.APP_RUNTIME = "web";
  await assert.rejects(setTerminalPermission(grant.id, true, grant.updatedAt), /桌面/);
  process.env.APP_RUNTIME = "test";
});

test("permission updates are authenticated, strict and versioned; a tool cannot invoke the terminal manually", async () => {
  const grant = await folder(false);
  const url = `/api/directory-grants/${grant.id}`;
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: true, revision: grant.updatedAt }, ""), ctx(grant.id))).status, 401);
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: true, revision: grant.updatedAt, extra: true }), ctx(grant.id))).status, 400);
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: true, revision: grant.updatedAt }), ctx(grant.id))).status, 200);
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: false, revision: grant.updatedAt }), ctx(grant.id))).status, 409);
  assert.equal((await manualRoute.POST(request("/api/tools/run", "POST", { tool: "runTerminalCommand", mode: "chat", input: { grantId: grant.id, command: echo } }))).status, 400);
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  assert.ok(tools.runTerminalCommand);
  assert.match(tools.runTerminalCommand.description!, new RegExp(grant.id));
  assert.equal((await createChatToolSet({ toolIds: [] })).runTerminalCommand, undefined);
  await revokeGrant(grant.id);
});

test("approved commands preserve working directory, Unicode output, stderr and exit code without inheriting app credentials", async () => {
  const grant = await folder();
  process.env.RIA_SYNTHETIC_SECRET = "not-for-child";
  const command = win
    ? "[Console]::WriteLine('你好'); [Console]::WriteLine((Get-Location).Path); [Console]::Error.WriteLine('synthetic-stderr'); [Console]::WriteLine($env:RIA_SYNTHETIC_SECRET); exit 7"
    : "printf '你好\\n'; pwd; printf 'synthetic-stderr' >&2; printf '%s' \"$RIA_SYNTHETIC_SECRET\"; exit 7";
  try {
    assert.equal(terminalEnvironment().RIA_SYNTHETIC_SECRET, undefined);
    assert.equal(terminalEnvironment().DATABASE_URL, undefined);
    assert.equal(terminalEnvironment().LOCAL_ACCESS_TOKEN, undefined);
    const input = await prepared(grant.id, command);
    const result = await runTerminalCommand(input);
    assert.equal(result.status, "failed"); assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /你好/); assert.ok(result.stdout.includes(grant.realPath));
    assert.match(result.stderr, /synthetic-stderr/); assert.ok(!result.stdout.includes("not-for-child"));
    assert.ok(result.finishedAt);
    assert.equal(getTerminalSession(result.id).status, "failed");
    await assert.rejects(runTerminalCommand(input), /已经执行/);
  } finally { delete process.env.RIA_SYNTHETIC_SECRET; }
});

test("successful commands cap output and report truncation", async () => {
  const grant = await folder();
  const command = win ? "[Console]::Write(('x' * 100000))" : "head -c 100000 /dev/zero | tr '\\000' 'x'";
  const result = await runTerminalCommand(await prepared(grant.id, command));
  assert.equal(result.status, "completed"); assert.equal(result.exitCode, 0);
  assert.equal(Buffer.byteLength(result.stdout), TERMINAL_LIMITS.outputBytes);
  assert.equal(result.truncated, true);
});

test("permission changes and re-granting invalidate pending approvals", async () => {
  const grant = await folder();
  const input = await prepared(grant.id);
  await setTerminalPermission(grant.id, false, grant.updatedAt);
  await assert.rejects(runTerminalCommand(input), /终端权限/);
  const disabled = (await listGrants()).find(row => row.id === grant.id)!;
  await setTerminalPermission(grant.id, true, disabled.updatedAt);
  const fresh = await prepared(grant.id);
  await createGrant({ path: grant.path });
  await assert.rejects(runTerminalCommand(fresh), /终端权限/);
  assert.equal((await listGrants()).find(row => row.id === grant.id)!.terminalEnabled, false);
});

for (const action of ["stop", "abort", "revoke", "disable"] as const) {
  test(`${action} stops a running command and preserves partial output`, async () => {
    const grant = await folder();
    const input = await prepared(grant.id, long);
    const controller = new AbortController();
    const pending = runTerminalCommand(input, controller.signal);
    try {
      await eventually(() => getTerminalSession(input.binding.sessionId).stdout.includes("ready"));
      if (action === "stop") {
        const url = `/api/terminal/sessions/${input.binding.sessionId}`;
        assert.equal((await sessionsRoute.GET(request(url, "GET", undefined, ""), ctx(input.binding.sessionId))).status, 401);
        assert.equal((await sessionsRoute.POST(request(url, "POST", { command: "not accepted" }), ctx(input.binding.sessionId))).status, 400);
        assert.equal((await sessionsRoute.POST(request(url, "POST"), ctx(input.binding.sessionId))).status, 200);
      } else if (action === "abort") controller.abort();
      else if (action === "revoke") await revokeGrant(grant.id);
      else await setTerminalPermission(grant.id, false, grant.updatedAt);
      const result = await pending;
      assert.equal(result.status, "stopped"); assert.match(result.stdout, /ready/); assert.ok(result.finishedAt);
      assert.equal(stopTerminalSession(result.id).status, "stopped");
    } finally { controller.abort(); await pending.catch(() => {}); }
  });
}

test("timeout and pre-aborted requests settle without leaving a running session", async () => {
  const grant = await folder();
  const timed = await runTerminalCommand(await prepared(grant.id, long, 1));
  assert.equal(timed.status, "timed-out"); assert.ok(timed.finishedAt);
  const controller = new AbortController(); controller.abort();
  const aborted = await runTerminalCommand(await prepared(grant.id), controller.signal);
  assert.equal(aborted.status, "stopped"); assert.ok(aborted.finishedAt); assert.equal(aborted.stdout, "");
});

test("concurrent commands are bounded and ordinary child processes terminate with their shell", async () => {
  const grant = await folder();
  const child = win ? "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60') -PassThru | ForEach-Object { [Console]::WriteLine($_.Id) }; Start-Sleep -Seconds 30" : "sleep 60 & echo $!; sleep 30";
  const first = await prepared(grant.id, child), second = await prepared(grant.id, long), third = await prepared(grant.id);
  const running = [runTerminalCommand(first), runTerminalCommand(second)];
  try {
    await assert.rejects(runTerminalCommand(third), /同时运行/);
    await eventually(() => /^\d+/m.test(getTerminalSession(first.binding.sessionId).stdout));
    const pid = Number(getTerminalSession(first.binding.sessionId).stdout.trim());
    stopTerminalSession(first.binding.sessionId); stopTerminalSession(second.binding.sessionId);
    await Promise.all(running);
    if (win) await eventually(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally {
    stopTerminalSession(first.binding.sessionId); stopTerminalSession(second.binding.sessionId);
    await Promise.allSettled(running);
  }
});

test("terminal approval inputs are immutable and cannot be claimed twice", async () => {
  const grant = await folder();
  const input = await prepared(grant.id);
  assert.deepEqual(await bindTerminalApproval(input), input);
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  const schema = asSchema(tools.runTerminalCommand.inputSchema);
  const revalidated = await schema.validate!(input);
  assert.equal(revalidated.success, true);
  if (revalidated.success) assert.deepEqual(revalidated.value, input);
  const chat = await db.chat.create({ data: { title: "Terminal approval" } });
  const part = { type: "tool-runTerminalCommand", toolCallId: "terminal-call", state: "approval-requested", input, approval: { id: "terminal-approval" } };
  await db.message.create({ data: { chatId: chat.id, role: "assistant", clientMessageId: "assistant-terminal", content: encodePersistedAssistantToolMessage({ type: "assistant-tool-message", text: "", tools: [{ ...part, toolName: "runTerminalCommand" }] }) } });
  const response = (command = input.command) => ({ id: "assistant-terminal", role: "assistant" as const, parts: [{ ...part, state: "approval-responded", input: { ...input, command }, approval: { ...part.approval, approved: true } }] }) as never;
  await assert.rejects(claimToolApproval(chat.id, response("different command")));
  await claimToolApproval(chat.id, response());
  await assert.rejects(claimToolApproval(chat.id, response()));
});

test("cancelling an execution record stops its terminal command and keeps the step cancelled", async () => {
  const grant = await folder();
  const input = await prepared(grant.id, long);
  const run = await startRun({ chatId: null, goal: "Terminal cancellation" });
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"], runId: run.id });
  const pending = tools.runTerminalCommand.execute!(input, {} as never);
  try {
    await eventually(() => { try { return getTerminalSession(input.binding.sessionId).stdout.includes("ready"); } catch { return false; } });
    await cancelRun(run.id, "user-request");
    await pending;
    assert.equal(getTerminalSession(input.binding.sessionId).status, "stopped");
    assert.equal((await db.agentStep.findFirstOrThrow({ where: { runId: run.id } })).state, "cancelled");
  } finally { stopTerminalSession(input.binding.sessionId); await Promise.resolve(pending).catch(() => {}); }
});

test("Windows shells and ordinary children stop when the local service exits", { skip: !win }, async () => {
  const moduleUrl = pathToFileURL(path.resolve("src/lib/terminal/powershell.ts")).href;
  const script = `
    import {spawn} from 'node:child_process';
    import {encodedPowerShellCommand} from ${JSON.stringify(moduleUrl)};
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encodedPowerShellCommand()],{
      windowsHide:true,env:{...process.env,RIA_TERMINAL_COMMAND:"$child=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru; [Console]::WriteLine($child.Id); Start-Sleep -Seconds 60"},stdio:['ignore','pipe','pipe']
    });
    let output=''; child.stdout.on('data',data=>{output+=data; if (/^\\d+/.test(output)) process.send({shell:child.pid,child:Number(output.trim())});});
    child.stderr.on('data',data=>process.send({error:String(data)}));
  `;
  const worker = spawn(process.execPath, ["--import", "./tests/helpers/register-typescript.ts", "--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const pids = await new Promise<{ shell: number; child: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Terminal worker did not become ready")), 10_000);
      worker.once("message", (value: { shell: number; child: number; error?: string }) => { clearTimeout(timer); if (value.error) reject(new Error(value.error)); else resolve(value); });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
    });
    worker.kill();
    await eventually(() => [pids.shell, pids.child].every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }));
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); }
});
