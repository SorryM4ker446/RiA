import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  globalThis.__riaRateLimitStore?.clear();
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

test("new terminal inputs have no timeout while old approval payloads remain readable", () => {
  assert.equal(terminalInputSchema.parse({ grantId: "folder", command: echo }).timeoutSeconds, undefined);
  assert.equal(terminalInputSchema.parse({ grantId: "folder", command: echo, timeoutSeconds: 1 }).timeoutSeconds, 1);
});

test("terminal commands remain usable in a long-running LLM turn", async () => {
  const grant = await folder();
  const run = await startRun({ chatId: null, goal: "Commands without time limits" });
  await db.agentRun.update({ where: { id: run.id }, data: { startedAt: new Date(Date.now() - 3_600_000) } });
  try {
    for (let i = 0; i < 2; i++) {
      const input = await bindTerminalApproval({ grantId: grant.id, command: echo });
      const result = await runTerminalCommand(input, undefined, run.id);
      assert.equal(result.status, "completed");
      assert.match(result.stdout, /ready/);
    }
  } finally { await revokeGrant(grant.id); }
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
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: true, terminalApprovalMode: "sometimes", revision: grant.updatedAt }), ctx(grant.id))).status, 400);
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: true, revision: grant.updatedAt }), ctx(grant.id))).status, 200);
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: false, revision: grant.updatedAt }), ctx(grant.id))).status, 409);
  assert.equal((await manualRoute.POST(request("/api/tools/run", "POST", { tool: "runTerminalCommand", mode: "chat", input: { grantId: grant.id, command: echo } }))).status, 400);
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  const schema = await asSchema(tools.runTerminalCommand.inputSchema).jsonSchema;
  assert.equal((schema.properties as Record<string, unknown>).timeoutSeconds, undefined);
  assert.ok(tools.runTerminalCommand);
  assert.match(tools.runTerminalCommand.description!, new RegExp(grant.id));
  assert.equal((await createChatToolSet({ toolIds: [] })).runTerminalCommand, undefined);
  await revokeGrant(grant.id);
});

test("terminal approval follows each folder's current mode and changing modes invalidates bound commands", async () => {
  const approval = await folder();
  const full = await folder();
  const old = await prepared(full.id);
  const url = `/api/directory-grants/${full.id}`;
  assert.equal((await permissionRoute.PATCH(request(url, "PATCH", { terminalEnabled: true, terminalApprovalMode: "full-access", revision: full.updatedAt }), ctx(full.id))).status, 200);
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  const needsApproval = tools.runTerminalCommand.needsApproval;
  assert.equal(typeof needsApproval, "function");
  if (typeof needsApproval !== "function") assert.fail("Missing approval decision");
  const decision = async (input: unknown) => needsApproval(input, {} as never);
  const first = { grantId: approval.id, command: echo };
  assert.equal(await decision(first), true);
  assert.equal(await decision({ grantId: approval.id, command: echo }), true);
  const automatic = { grantId: full.id, command: echo };
  assert.equal(await decision(automatic), false);
  assert.ok("binding" in automatic);
  assert.equal((await tools.runTerminalCommand.execute!(automatic, {} as never) as { status: string }).status, "completed");
  await assert.rejects(runTerminalCommand(old), /已变化/);
  const pending = await prepared(full.id);
  const current = (await listGrants()).find(row => row.id === full.id)!;
  assert.equal(current.terminalApprovalMode, "full-access");
  await setTerminalPermission(full.id, true, current.updatedAt, "approval");
  assert.equal(await decision({ grantId: full.id, command: echo }), true, "an existing toolset must read the new mode");
  await assert.rejects(runTerminalCommand(pending), /已变化/);
  await assert.rejects(decision(pending), /已变化/);
  const latest = (await listGrants()).find(row => row.id === full.id)!;
  await setTerminalPermission(full.id, true, latest.updatedAt, "full-access");
  await createGrant({ path: full.path });
  const reset = (await listGrants()).find(row => row.id === full.id)!;
  assert.equal(reset.terminalEnabled, false);
  assert.equal(reset.terminalApprovalMode, "approval");
  await assert.rejects(decision({ grantId: full.id, command: echo }), /终端权限/);
});

test("scripts exceeding the former input and Windows environment limits execute intact with Unicode", async () => {
  const grant = await folder();
  const payload = "长脚本🙂".repeat(30_000);
  const command = win
    ? `[IO.File]::WriteAllText('long-input.txt', '${payload}', (New-Object System.Text.UTF8Encoding($false))); [Console]::WriteLine('tail-你好')`
    : `printf '%s' '${payload}' > long-input.txt; printf 'tail-你好'`;
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  const validated = await asSchema(tools.runTerminalCommand.inputSchema).validate!({ grantId: grant.id, command });
  assert.equal(validated.success, true);
  if (!validated.success) assert.fail("Long input rejected");
  const result = await runTerminalCommand(validated.value);
  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.command, command);
  assert.match(result.stdout, /tail-你好/);
  assert.equal(readFileSync(path.join(grant.path, "long-input.txt"), "utf8"), payload);
  assert.equal(terminalInputSchema.safeParse({ grantId: grant.id, command: " " }).success, false);
  assert.equal(terminalInputSchema.safeParse({ grantId: grant.id, command: "a\0b" }).success, false);
});

test("tool results omit the script while the exact command remains in its input and session", async () => {
  const grant = await folder();
  const command = "# 长脚本🙂\n".repeat(180_000) + echo;
  assert.ok(Buffer.byteLength(command) > 2 * 1024 * 1024);
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  const input = await prepared(grant.id, command);
  const output = await tools.runTerminalCommand.execute!(input, { toolCallId: "result-without-script", messages: [] });
  const session = await getTerminalSession(input.binding!.sessionId);
  assert.equal(session.command, command);
  assert.equal(input.command, command);
  const { command: _command, ...expected } = session;
  assert.deepEqual(output, expected);
  assert.equal(Object.hasOwn(output as object, "command"), false);
  assert.equal(session.status, "completed", session.stderr);
  assert.match(session.stdout, /ready/);
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
  // The shared head plus this stream's tail is captured; the omitted middle is marked.
  assert.equal(result.stdout.replace(/[^x]/g, "").length, TERMINAL_LIMITS.outputBytes - TERMINAL_LIMITS.tailBytes);
  assert.match(result.stdout, new RegExp(`\\[${100_000 - TERMINAL_LIMITS.outputBytes + TERMINAL_LIMITS.tailBytes} bytes omitted from this capture\\]`));
  assert.equal(result.truncated, true);
  assert.equal(result.log?.stdoutBytes, 100_000);
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

for (const action of ["stop", "abort", "revoke", "disable", "change-mode"] as const) {
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
      else await setTerminalPermission(grant.id, action === "change-mode", grant.updatedAt, "full-access");
      const result = await pending;
      assert.equal(result.status, "stopped"); assert.match(result.stdout, /ready/); assert.ok(result.finishedAt);
      assert.equal(stopTerminalSession(result.id).status, "stopped");
    } finally { controller.abort(); await pending.catch(() => {}); }
  });
}

test("legacy timeout values do not stop a running command and explicit stop still works", async () => {
  const grant = await folder();
  const input = await prepared(grant.id, long, 1);
  const pending = runTerminalCommand(input);
  try {
    await eventually(() => getTerminalSession(input.binding.sessionId).stdout.includes("ready"));
    // Cross the old one-second deadline; this is the behavior being removed.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(getTerminalSession(input.binding.sessionId).status, "running");
  } finally { stopTerminalSession(input.binding.sessionId); await pending; }
  assert.equal((await pending).status, "stopped");
});

test("pre-aborted requests settle without leaving a running session", async () => {
  const grant = await folder();
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
      windowsHide:true,env:process.env,stdio:['pipe','pipe','pipe']
    });
    child.stdin.end("$child=Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru; [Console]::WriteLine($child.Id); Start-Sleep -Seconds 60", 'utf8');
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


test("the general terminal replaces separate file tools and advertises only currently authorized folders", async () => {
  const grant = await folder();
  const { listPublicToolCatalog, getToolDescriptor } = await import("@/tools/catalog");
  const catalog = await listPublicToolCatalog("chat");
  for (const id of ["listLocalFiles", "readLocalFile", "writeLocalFile"]) {
    assert.equal(catalog.some(tool => tool.id === id), false);
    assert.equal(getToolDescriptor(id), null);
  }
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"] });
  assert.equal(typeof getToolDescriptor("runTerminalCommand")?.requiresApproval, "function");
  assert.equal(typeof tools.runTerminalCommand.needsApproval, "function");
  assert.match(tools.runTerminalCommand.description!, /edit or overwrite existing files/);
  assert.ok(tools.runTerminalCommand.description!.includes(JSON.stringify(grant.realPath)));
  await revokeGrant(grant.id);
  assert.ok(!(await createChatToolSet({ toolIds: ["runTerminalCommand"] })).runTerminalCommand?.description?.includes(grant.id));
});

test("approved PowerShell can create, read, edit, search, copy, move, rename and delete source files", { skip: !win }, async () => {
  const grant = await folder();
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "New-Item -ItemType Directory -Path 'operations' | Out-Null",
    "Set-Content -LiteralPath 'operations/source.js' -Value 'const answer = 1;' -Encoding UTF8",
    "[Console]::WriteLine((Get-Content -LiteralPath 'operations/source.js' -Raw))",
    "Set-Content -LiteralPath 'operations/source.js' -Value 'const answer = 42;' -Encoding UTF8",
    "Select-String -LiteralPath 'operations/source.js' -Pattern '42' | ForEach-Object { [Console]::WriteLine($_.Line) }",
    "Copy-Item -LiteralPath 'operations/source.js' -Destination 'operations/copy.js'",
    "Rename-Item -LiteralPath 'operations/copy.js' -NewName 'renamed.js'",
    "Move-Item -LiteralPath 'operations/renamed.js' -Destination 'moved.js'",
    "Remove-Item -LiteralPath 'operations/source.js'",
    "Remove-Item -LiteralPath 'operations'",
    "[Console]::WriteLine((Get-ChildItem -File | Select-Object -ExpandProperty Name))",
  ].join("; ");
  const approved = await prepared(grant.id, command);
  assert.equal(existsSync(path.join(grant.realPath, "moved.js")), false, "preparing the review must not execute anything");
  const result = await runTerminalCommand(approved);
  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /const answer = 1/);
  assert.match(result.stdout, /const answer = 42/);
  assert.match(result.stdout, /moved.js/);
  assert.match(readFileSync(path.join(grant.realPath, "moved.js"), "utf8"), /42/);
  assert.equal(existsSync(path.join(grant.realPath, "operations")), false);
});


test("terminal environment preserves installed-tool discovery and runtime paths while excluding RiA secrets and service flags", () => {
  const inherited = terminalEnvironment({ Path: "C:/Tools;C:/Python;C:/Go/bin", PATHEXT: ".EXE;.CMD", GOPATH: "C:/work/go", GOROOT: "C:/Go", NODE_PATH: "C:/modules", NVM_HOME: "C:/nvm", PYTHONPATH: "C:/python-modules", VIRTUAL_ENV: "C:/project/.venv", JAVA_HOME: "C:/jdk", NODE_ENV: "production", NODE_OPTIONS: "--require internal-loader", ELECTRON_RUN_AS_NODE: "1", OPENROUTER_API_KEY: "excluded", DEEPSEEK_API_KEY: "excluded", DATABASE_URL: "excluded", LOCAL_ACCESS_TOKEN: "excluded", CUSTOM_SECRET: "excluded" });
  assert.equal(inherited.Path, "C:/Tools;C:/Python;C:/Go/bin");
  assert.equal(inherited.PATHEXT, ".EXE;.CMD");
  for (const [key, expected] of Object.entries({ GOPATH: "C:/work/go", GOROOT: "C:/Go", NODE_PATH: "C:/modules", NVM_HOME: "C:/nvm", PYTHONPATH: "C:/python-modules", VIRTUAL_ENV: "C:/project/.venv", JAVA_HOME: "C:/jdk" })) assert.equal(inherited[key], expected);
  for (const key of ["NODE_ENV", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "DATABASE_URL", "LOCAL_ACCESS_TOKEN", "CUSTOM_SECRET"]) assert.equal(inherited[key], undefined);
  assert.deepEqual(terminalEnvironment({ NODE_ENV: "production" }), {});
});

test("approved PowerShell discovers optional installed runtimes without requiring a particular toolchain", { skip: !win }, async () => {
  const grant = await folder();
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::WriteLine('shell-ready')",
    "foreach ($toolName in @('node', 'python', 'go')) { $resolvedTool = Get-Command $toolName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($resolvedTool) { [Console]::WriteLine(('discovered:' + $toolName)); if ($toolName -eq 'go') { & $toolName version } else { & $toolName --version }; if ($LASTEXITCODE -ne 0) { [Console]::WriteLine(('unavailable:' + $toolName)) } } }; exit 0",
  ].join("; ");
  const result = await runTerminalCommand(await prepared(grant.id, command));
  assert.equal(result.status, "completed", result.stderr);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /shell-ready/);
});

test("commands discover arbitrary installed tools in custom Unicode paths and observe environment changes between approvals", { skip: !win }, async () => {
  const grant = await folder();
  const key = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
  const previous = process.env[key];
  const previousExtensions = process.env.PATHEXT;
  try {
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    for (const version of ["first", "second"]) {
      const bin = path.join(grant.realPath, `自定义 tools ${version}`);
      mkdirSync(bin);
      writeFileSync(path.join(bin, "ria-runtime-probe.cmd"), `@echo off\r\necho portable-${version}\r\nexit /b 0\r\n`);
      process.env[key] = `${bin};${previous ?? ""}`;
      const result = await runTerminalCommand(await prepared(grant.id, "& (Get-Command ria-runtime-probe -ErrorAction Stop)"));
      assert.equal(result.status, "completed", result.stderr);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, new RegExp(`portable-${version}`));
    }
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    if (previousExtensions === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = previousExtensions;
  }
});

test("an explicit missing executable fails visibly without loading a same-named module or installing a replacement", { skip: !win }, async () => {
  const grant = await folder();
  const missing = `ria-missing-runtime-${Date.now()}`;
  const modules = path.join(grant.realPath, "modules");
  const fixtureModule = path.join(modules, "MissingRuntimeProbe");
  mkdirSync(fixtureModule, { recursive: true });
  writeFileSync(path.join(fixtureModule, "MissingRuntimeProbe.psd1"), `@{ RootModule = 'MissingRuntimeProbe.psm1'; ModuleVersion = '1.0'; FunctionsToExport = @('${missing}') }`);
  writeFileSync(path.join(fixtureModule, "MissingRuntimeProbe.psm1"), `[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'imported.txt'), 'unexpected import'); function ${missing} { 'not an executable' }; Export-ModuleMember -Function '${missing}'`);
  const previousModules = process.env.PSModulePath;
  process.env.PSModulePath = `${modules};${previousModules ?? ""}`;
  try {
    // An unqualified Get-Command may import a module even with a type filter.
    // A file-qualified executable has no such ambiguity and must simply fail.
    for (const policy of ["Restricted", "Bypass"]) {
      // Set policy only inside this test's approved shell, never in the
      // machine/user registry. The terminal does not inherit policy overrides.
      const result = await runTerminalCommand(await prepared(grant.id, `$env:PSExecutionPolicyPreference = '${policy}'; & '.\\${missing}.exe'`));
      assert.equal(result.status, "failed", policy);
      assert.notEqual(result.exitCode, 0, policy);
      assert.ok(result.stderr.includes(missing), `${policy}: ${result.stderr}`);
      assert.equal(existsSync(path.join(fixtureModule, "imported.txt")), false, policy);
    }
    // Import a unique explicit fixture path to prove the test did not merely
    // rely on local script policy blocking all module loads.
    const imported = await runTerminalCommand(await prepared(grant.id, `$env:PSExecutionPolicyPreference = 'Bypass'; Import-Module '${path.join(fixtureModule, "MissingRuntimeProbe.psd1").replaceAll("'", "''")}'; & '${missing}'`));
    assert.equal(imported.status, "completed", imported.stderr);
    assert.match(imported.stdout, /not an executable/);
    assert.equal(existsSync(path.join(fixtureModule, "imported.txt")), true);
  } finally {
    if (previousModules === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previousModules;
  }
});
