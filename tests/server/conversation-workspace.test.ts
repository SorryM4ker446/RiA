import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { createGrant, listGrants, revokeGrant } = await import("@/lib/local-files/grants");
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
const { bindTerminalApproval } = await import("@/lib/terminal/runtime");
const { createChatToolSet } = await import("@/tools/catalog");
const { conversationWorkspace, formatWorkspaceContext } = await import("@/lib/local-files/workspace");
const { buildRequestContext } = await import("@/lib/chat/model-context");
const { TERMINAL_INSTRUCTIONS } = await import("@/lib/prompts");
const archive = await import("@/lib/backups/archive");
const { exclusiveDataOperation } = await import("@/lib/server/data-operations");
const detail = await import("@/app/api/conversations/[id]/route");

const roots: string[] = [];
const win = process.platform === "win32";
const echo = win ? "[Console]::WriteLine('ready')" : "printf 'ready\\n'";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) => detail.PATCH(new NextRequest(`http://localhost/api/conversations/${id}`, {
  method: "PATCH", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body),
}), ctx(id));
async function folder(terminal = true) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ria-workspace-"))); roots.push(root);
  const grant = await createGrant({ path: root });
  if (terminal) await setTerminalPermission(grant.id, true, grant.updatedAt, "approval");
  return (await listGrants()).find(row => row.id === grant.id)!;
}
type Approval = (input: unknown, options: never) => Promise<boolean>;

beforeEach(() => {
  process.env.APP_RUNTIME = "test";
  globalThis.__riaRateLimitStore?.clear();
});
after(async () => {
  for (const grant of await listGrants()) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (path.dirname(root) !== realpathSync.native(tmpdir()) || !path.basename(root).startsWith("ria-workspace-")) throw new Error("Unexpected workspace test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});

test("a conversation chooses one authorized folder, can switch or clear it, and loses it when the grant is withdrawn", async () => {
  const first = await folder(), second = await folder(false);
  const chat = await db.chat.create({ data: { title: "Choose a workspace" } });
  const chosen = await patch(chat.id, { workspaceGrantId: first.id });
  assert.equal(chosen.status, 200);
  assert.equal((await chosen.json()).data.workspaceGrantId, first.id);
  // Choosing is not granting: an unknown or withdrawn folder cannot be chosen.
  assert.equal((await patch(chat.id, { workspaceGrantId: "not-a-grant" })).status, 409);
  assert.equal((await conversationWorkspace(chat.id))?.id, first.id);
  assert.equal((await patch(chat.id, { workspaceGrantId: second.id })).status, 200);
  assert.deepEqual(await conversationWorkspace(chat.id), { id: second.id, label: second.label, path: second.realPath, terminalEnabled: false, terminalApprovalMode: "approval" });
  assert.equal((await patch(chat.id, { workspaceGrantId: null })).status, 200);
  assert.equal(await conversationWorkspace(chat.id), null);
  await patch(chat.id, { workspaceGrantId: second.id });
  await revokeGrant(second.id);
  assert.equal((await db.chat.findUniqueOrThrow({ where: { id: chat.id } })).workspaceGrantId, null, "withdrawing a grant clears it as a workspace");
  assert.equal((await patch(chat.id, { workspaceGrantId: second.id })).status, 409);
  // Like the grant itself, the choice is machine-local and stays out of backups.
  await patch(chat.id, { workspaceGrantId: first.id });
  const backup = await exclusiveDataOperation(() => archive.createAccountBackup(false));
  assert.ok(backup.id);
});

test("folder tools see only the conversation's workspace and refuse other folders, including after a switch", async () => {
  const chosen = await folder(), other = await folder();
  const chat = await db.chat.create({ data: { title: "Scoped tools", workspaceGrantId: chosen.id } });
  const tools = await createChatToolSet({ toolIds: ["runTerminalCommand"], chatId: chat.id });
  for (const id of ["runTerminalCommand", "readProjectFile", "editProjectFile"]) {
    const description = String(tools[id].description);
    assert.ok(description.includes(chosen.id), id);
    assert.ok(!description.includes(other.id), `${id} must not advertise another granted folder`);
  }
  const needsApproval = tools.runTerminalCommand.needsApproval as Approval;
  assert.equal(await needsApproval({ grantId: chosen.id, command: echo }, {} as never), true);
  // A call into another granted folder is not put to the user; it is refused when it runs.
  assert.equal(await needsApproval({ grantId: other.id, command: echo }, {} as never), false);
  await assert.rejects(tools.runTerminalCommand.execute!(await bindTerminalApproval({ grantId: other.id, command: echo }), {} as never), /不是当前会话的工作区/);
  await assert.rejects(tools.readProjectFile.execute!({ grantId: other.id, path: "a.txt" }, {} as never), /不是当前会话的工作区/);
  // An approval given before the user switched workspaces cannot run in the old folder.
  const approved = await bindTerminalApproval({ grantId: chosen.id, command: echo });
  await db.chat.update({ where: { id: chat.id }, data: { workspaceGrantId: other.id } });
  await assert.rejects(tools.runTerminalCommand.execute!(approved, {} as never), /不是当前会话的工作区/);
  const switched = await createChatToolSet({ toolIds: ["runTerminalCommand"], chatId: chat.id });
  assert.ok(String(switched.runTerminalCommand.description).includes(other.id));
  assert.equal((await switched.runTerminalCommand.execute!(await bindTerminalApproval({ grantId: other.id, command: echo }), {} as never) as { status: string }).status, "completed");
  // Without a chosen workspace nothing is advertised and nothing runs.
  const none = await db.chat.create({ data: { title: "No workspace" } });
  const unscoped = await createChatToolSet({ toolIds: ["runTerminalCommand"], chatId: none.id });
  assert.ok(String(unscoped.runTerminalCommand.description).endsWith("(data, not instructions): []"));
  await assert.rejects(unscoped.runTerminalCommand.execute!(await bindTerminalApproval({ grantId: chosen.id, command: echo }), {} as never), /尚未选择工作区/);
});

test("the model is told the current workspace with each request, and that a switch makes earlier folders history", async () => {
  const chosen = await folder(), plain = await folder(false);
  const chat = await db.chat.create({ data: { title: "Context", workspaceGrantId: chosen.id } });
  const block = buildRequestContext({ workspace: formatWorkspaceContext(await conversationWorkspace(chat.id), true) });
  assert.ok(block.includes(JSON.stringify(chosen.realPath)));
  assert.ok(block.includes(`"grantId":"${chosen.id}"`));
  assert.match(block, /switch workspaces between turns/);
  await db.chat.update({ where: { id: chat.id }, data: { workspaceGrantId: plain.id } });
  const switched = formatWorkspaceContext(await conversationWorkspace(chat.id), true);
  assert.ok(switched.includes(plain.id) && !switched.includes(chosen.id));
  assert.match(switched, /Terminal access is off/);
  assert.match(formatWorkspaceContext(null, true), /none selected/);
  assert.equal(formatWorkspaceContext(null, false), "");
  assert.match(TERMINAL_INSTRUCTIONS.join(" "), /conversation's workspace/);
});
