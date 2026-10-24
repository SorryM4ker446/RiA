import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, beforeEach, test, type TestContext } from "node:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { createTestDatabase } from "../helpers/database";
import { localAccessCookie } from "../helpers/local-access";
import { seedTestModelPreferences } from "../helpers/model-library";
import { languageModel, resetProviderState } from "../helpers/model-provider";

const cleanup = createTestDatabase();
process.env.RIA_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const route = await import("@/app/api/chat/route");
const { createGrant, revokeGrant } = await import("@/lib/local-files/grants");
const { setTerminalPermission } = await import("@/lib/terminal/permissions");
const { decodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { collectEditedFiles } = await import("@/lib/terminal/file-change-summary");
const { contentHash } = await import("@/lib/project-files/text");
const roots: string[] = [];
beforeEach(async (t: TestContext) => {
  t.mock.method(console, "error", () => {}); t.mock.method(console, "info", () => {});
  resetProviderState(); globalThis.__riaRateLimitStore?.clear();
  process.env.APP_RUNTIME = "test"; process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  await db.chat.deleteMany({});
  await seedTestModelPreferences(db);
});
after(async () => {
  for (const grant of await db.directoryGrant.findMany({ where: { revokedAt: null } })) await revokeGrant(grant.id);
  await db.$disconnect();
  for (const root of roots) {
    if (dirname(root) !== realpathSync.native(tmpdir()) || !basename(root).startsWith("ria-edit-chat-")) throw new Error("Unexpected test directory");
    rmSync(root, { recursive: true, force: true });
  }
  cleanup();
});
const ui = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const request = (body: unknown) => new NextRequest("http://localhost/api/chat", { method: "POST", headers: { cookie: localAccessCookie(), "content-type": "application/json" }, body: JSON.stringify(body) });
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

test("a model reads, fails an inexact edit, sees why, corrects it and the file changes once", { timeout: 30_000 }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-edit-chat-"))); roots.push(root);
  writeFileSync(join(root, "math.ts"), "export function add(a: number, b: number) {\n  return a - b;\n}\n");
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt, "full-access");
  const hash = contentHash(readFileSync(join(root, "math.ts")));
  const prompts: string[] = [];
  const steps = [
    { name: "readProjectFile", input: { grantId: grant.id, path: "math.ts" } },
    { name: "editProjectFile", input: { grantId: grant.id, path: "math.ts", expectedHash: hash, edits: [{ oldText: "return a - b;\n", newText: "return a + b;\n" }, { oldText: "  return a-b;", newText: "x" }] } },
    { name: "editProjectFile", input: { grantId: grant.id, path: "math.ts", expectedHash: hash, edits: [{ oldText: "  return a - b;", newText: "  return a + b;" }] } },
  ];
  let call = 0;
  t.mock.method(languageModel, "doStream", async options => {
    prompts.push(JSON.stringify(options.prompt));
    const step = steps[call++];
    return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] });
      if (step) controller.enqueue({ type: "tool-call", toolCallId: `call-${call}`, toolName: step.name, input: JSON.stringify(step.input) });
      else { controller.enqueue({ type: "text-start", id: "a" }); controller.enqueue({ type: "text-delta", id: "a", delta: "Fixed add()." }); controller.enqueue({ type: "text-end", id: "a" }); }
      controller.enqueue({ type: "finish", finishReason: { unified: step ? "tool-calls" : "stop", raw: undefined }, usage });
      controller.close();
    } }) };
  });
  const response = await route.POST(request({ chatId: (await db.chat.create({ data: { title: "Workspace", workspaceGrantId: grant.id } })).id, messages: [ui("edit-user", "Fix add() in math.ts")] }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Fixed add\(\)/);
  assert.equal(readFileSync(join(root, "math.ts"), "utf8"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  assert.match(prompts[1], /"line":2,"text":"  return a - b;"/, "the read result reaches the model");
  assert.match(prompts[2], /edits\[1\]\.oldText was not found/, "the failed edit explains itself to the model");
  assert.match(prompts[2], /Lines containing its first line|No line contains/);
  const rows = await db.message.findMany({ where: { role: "assistant" } });
  const saved = decodePersistedAssistantToolMessage(rows[0].content)!;
  const edits = saved.tools.filter(tool => tool.toolName === "editProjectFile");
  assert.deepEqual(edits.map(tool => tool.state), ["output-error", "output-available"]);
  const summary = collectEditedFiles(saved.tools.map(tool => ({ type: `tool-${tool.toolName}`, state: tool.state, output: tool.output })));
  assert.deepEqual(summary.files.map(file => [file.path, file.kind]), [["math.ts", "modified"]]);
});

test("in approval mode the edit waits with its diff and nothing is written until approved", { timeout: 30_000 }, async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-edit-chat-"))); roots.push(root);
  writeFileSync(join(root, "README.md"), "# Old title\n");
  const grant = await createGrant({ path: root });
  await setTerminalPermission(grant.id, true, grant.updatedAt, "approval");
  const hash = contentHash(readFileSync(join(root, "README.md")));
  t.mock.method(languageModel, "doStream", async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    controller.enqueue({ type: "tool-call", toolCallId: "edit-1", toolName: "editProjectFile", input: JSON.stringify({ grantId: grant.id, path: "README.md", expectedHash: hash, edits: [{ oldText: "Old title", newText: "New title" }] }) });
    controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage });
    controller.close();
  } }) }));
  const response = await route.POST(request({ chatId: (await db.chat.create({ data: { title: "Workspace", workspaceGrantId: grant.id } })).id, messages: [ui("approval-user", "Rename the title")] }));
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /approval-requested|tool-approval-request/);
  assert.match(wire, /-# Old title\\n\+# New title/, "the approval carries the server-computed diff");
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Old title\n");
});
