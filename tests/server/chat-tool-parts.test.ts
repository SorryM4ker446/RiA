import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { chatRequestSchema } = await import("@/lib/server/request-schemas");
const { listToolDescriptors } = await import("@/tools/catalog");

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  await db.message.deleteMany({});
  await db.chat.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

/** One input each tool's own schema accepts, so the part is valid for its tool. */
const VALID_INPUTS: Record<string, unknown> = {
  runTerminalCommand: { grantId: "grant-1", command: "Get-Date" },
  readTerminalLog: { logId: "8d9c6f0e-4b7a-4c1d-9e2f-3a5b6c7d8e9f", stream: "stdout", startLine: 1, lineCount: 50 },
  readProjectFile: { grantId: "grant-1", path: "src/app.ts", startLine: 1, lineCount: 400 },
  editProjectFile: { grantId: "grant-1", path: "src/app.ts", expectedHash: "0123456789abcdef", edits: [{ oldText: "a - b", newText: "a + b" }],
    binding: { grantId: "grant-1", revision: "2026-10-21T00:00:00.000Z", cwd: "C:/project", path: "src/app.ts", beforeHash: "0123456789abcdef", afterHash: "fedcba9876543210", diff: "-a - b\n+a + b", added: 1, removed: 1, created: false } },
  saveMemory: { key: "units", value: "metric" },
  searchKnowledge: { query: "notes" },
  createTask: { title: "buy milk" },
  compactContext: { focus: "keep the failing test name" },
  webSearch: { query: "weather" },
  listLocalFiles: { grantId: "grant-1", path: "" },
  readLocalFile: { grantId: "grant-1", path: "notes.md" },
  writeLocalFile: { grantId: "grant-1", path: "notes.md", content: "x" },
  readDocument: { documentId: "document-1" },
  convertDocument: { documentId: "document-1", format: "docx" },
  readPluginSkill: { packageId: "skills.sh.sample", path: "SKILL.md" },
};

/**
 * The shape a real follow-up turn has: the tool-bearing assistant message is in
 * the history, and the new user message is last.
 */
function followUp(parts: unknown[]) {
  return {
    id: "req-1",
    model: { providerId: "openrouter", modelId: "vendor/model" },
    trigger: "submit-message",
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "do the thing" }] },
      { id: "a1", role: "assistant", parts },
      { id: "u2", role: "user", parts: [{ type: "text", text: "and now this" }] },
    ],
  };
}

test("every chat tool can appear in the history of the next request", () => {
  const tools = listToolDescriptors("chat");
  assert.ok(tools.length > 0, "the catalog has chat tools to check");

  for (const tool of tools) {
    const input = VALID_INPUTS[tool.id];
    assert.ok(input, `${tool.id} has a sample input in this test`);
    const result = chatRequestSchema.safeParse(followUp([
      { type: `tool-${tool.id}`, toolCallId: "call-1", state: "output-available", input, output: { ok: true } },
    ]));
    // The assistant tool part is persisted, rehydrated by the client as
    // `tool-<name>`, and echoed back on every later request. A tool missing
    // from the accepted names does not reject one message, it ends the
    // conversation: nothing the user types afterwards can get through.
    assert.equal(
      result.success, true,
      `tool-${tool.id} was rejected: ${result.success ? "" : result.error.issues.map((issue: { message: string }) => issue.message).join("; ")}`,
    );
  }
});

test("a tool part naming something that is not in the catalog is still refused", () => {
  const result = chatRequestSchema.safeParse(followUp([
    { type: "tool-notARealTool", toolCallId: "call-1", state: "output-available", input: {}, output: {} },
  ]));
  assert.equal(result.success, false);
});

test("a known tool with an input its own schema rejects is still refused", () => {
  const result = chatRequestSchema.safeParse(followUp([
    { type: "tool-createTask", toolCallId: "call-1", state: "output-available", input: { title: "" }, output: {} },
  ]));
  // Deriving the accepted names from the catalog must not have weakened the
  // per-tool input check that was already there.
  assert.equal(result.success, false);
});

test("long reasoning remains intact in completed history and active approval continuations", () => {
  const reasoning = "r".repeat(141_815);
  const parts = [
    { type: "reasoning", text: reasoning, state: "done" },
    { type: "tool-runTerminalCommand", toolCallId: "terminal-long-reasoning", state: "output-available", input: VALID_INPUTS.runTerminalCommand, output: { status: "completed", stdout: "done", exitCode: 0 } },
  ];
  const result = chatRequestSchema.parse(followUp(parts));
  assert.deepEqual(result.messages[1].parts[0], parts[0]);
  const continuation = followUp([
    parts[0],
    { ...parts[1], state: "approval-responded", output: undefined, approval: { id: "long-reasoning-approval", approved: true } },
  ]);
  continuation.messages.pop();
  const resumed = chatRequestSchema.parse(continuation);
  assert.deepEqual(resumed.messages.at(-1)!.parts[0], parts[0]);
});

test("long assistant histories do not relax user limits or tool-state validation", () => {
  const history = Array.from({ length: 120 }, () => ({ type: "step-start" }));
  assert.equal(chatRequestSchema.safeParse(followUp(history)).success, true);
  for (const parts of [[{ type: "text", text: "u".repeat(100_001) }], Array.from({ length: 101 }, () => ({ type: "text", text: "input" })), [{ type: "reasoning", text: "not user input" }]]) {
    const body = followUp([]);
    body.messages[0].parts = parts;
    body.messages[1].parts = [{ type: "text", text: "answer" }];
    assert.equal(chatRequestSchema.safeParse(body).success, false);
  }
  assert.equal(chatRequestSchema.safeParse(followUp([...history, {
    type: "tool-runTerminalCommand", toolCallId: "invalid-command", state: "output-available", input: { grantId: "grant-1", command: "" }, output: { stdout: "done" },
  }])).success, false);
});
