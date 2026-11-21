import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelMessage } from "ai";
import type { UIMessage } from "ai";
import { buildChatContext } from "@/lib/chat/context";

const { createStepContext } = await import("@/lib/chat/step-context");
const { contextBudget } = await import("@/lib/models/context-budget");

/** A readProjectFile result as the tool returns it: about 64 KiB of the same 400 lines. */
function read(id: string, options: { hash?: string; startLine?: number; grantId?: string; marker?: string } = {}): ModelMessage[] {
  const startLine = options.startLine ?? 1;
  const lines = Array.from({ length: 400 }, (_, index) => ({ line: startLine + index, text: `${options.marker ?? "row"} ${startLine + index} ${"x".repeat(150)}` }));
  const value = { grantId: options.grantId ?? "grant-a", path: "src/big.ts", hash: options.hash ?? "0123456789abcdef", bytes: 66_000, totalLines: 2000, eol: "lf", bom: false, startLine, lines, nextLine: startLine + 400 };
  return [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readProjectFile", toolCallId: id, input: { grantId: value.grantId, path: value.path, startLine } }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readProjectFile", toolCallId: id, output: { type: "json", value } }] },
  ];
}
const manager = (handoff?: { state: string; calls: string[] }) => createStepContext({ budget: contextBudget({ contextLength: 1_000_000 }), system: "system", summarize: async () => "unused", ...(handoff ? { handoff } : {}) });
/** Each result as sent: the whole read, or the note naming the read it repeats. */
function results(messages: ModelMessage[]) {
  const calls = new Set<string>(), sent = new Map<string, string>();
  for (const message of messages) if (typeof message.content !== "string") for (const part of message.content) {
    if (part.type === "tool-call") calls.add(part.toolCallId);
    if (part.type === "tool-result") sent.set(part.toolCallId, part.output.type === "text" ? part.output.value : JSON.stringify(part.output));
  }
  return { calls, sent };
}

test("the same lines of the same file version read three times reach the model once; the later calls keep a result that points at it", async () => {
  const conversation: ModelMessage[] = [{ role: "user", content: "look at big.ts" }, ...read("read-1"), ...read("read-2"), ...read("read-3")];
  const once = manager();
  const prepared = await once.prepare(conversation);
  const { calls, sent } = results(prepared.messages);
  assert.deepEqual([...calls], ["read-1", "read-2", "read-3"]);
  assert.deepEqual([...sent.keys()], ["read-1", "read-2", "read-3"], "every call still has its result");
  assert.match(sent.get("read-1")!, /row 400 x{150}/);
  for (const id of ["read-2", "read-3"]) {
    assert.ok(sent.get(id)!.length < 600, `${id} is a short note`);
    const note = JSON.parse(sent.get(id)!);
    assert.deepEqual([note.unchanged, note.path, note.hash, note.startLine, note.endLine, note.nextLine], [true, "src/big.ts", "0123456789abcdef", 1, 400, 401]);
    assert.equal(note.toolCallId, "read-1");
  }
  // About a third of what the three whole copies took.
  const whole = JSON.stringify(conversation).length, now = JSON.stringify(prepared.messages).length;
  assert.ok(now < whole * 0.4, `${now} of ${whole}`);
  // The stored conversation is not changed: only what is sent.
  assert.match(JSON.stringify(conversation[4]), /row 400/);
  // The next step sends the same thing again, so a provider's cache keeps matching it.
  assert.equal(JSON.stringify((await once.prepare(conversation)).messages), JSON.stringify(prepared.messages));
});

test("a read of changed content, other lines or another folder is sent whole, and so is one whose earlier copy was folded into the summary", async () => {
  const changed = results((await manager().prepare([{ role: "user", content: "go" }, ...read("a"), ...read("b", { hash: "fedcba9876543210", marker: "edited" })])).messages).sent;
  assert.match(changed.get("b")!, /edited 400/);
  const range = results((await manager().prepare([{ role: "user", content: "go" }, ...read("a"), ...read("b", { startLine: 401 })])).messages).sent;
  assert.match(range.get("b")!, /row 800/);
  const folder = results((await manager().prepare([{ role: "user", content: "go" }, ...read("a"), ...read("b", { grantId: "grant-b" })])).messages).sent;
  assert.match(folder.get("b")!, /row 400/);
  // The first read now lives only in the summary: the model no longer has its text, so the later one is sent whole.
  const folded = await manager({ state: "Read big.ts earlier.", calls: ["a"] }).prepare([{ role: "user", content: "go" }, ...read("a"), ...read("b")]);
  const sent = results(folded.messages).sent;
  assert.equal(sent.has("a"), false);
  assert.match(sent.get("b")!, /row 400 x{150}/);
});

test("the history window counts references and terminal previews before deciding which turns fit", () => {
  const text = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
  const output = { grantId: "folder", path: "test.txt", hash: "a", startLine: 1, lines: [{ line: 1, text: "example ".repeat(850) }], nextLine: null };
  const evidence = [1, 2, 3].flatMap(id => [
    { type: "tool-readProjectFile", toolCallId: `read-${id}`, state: "output-available", input: {}, output },
    { type: "step-start" },
  ]) as UIMessage["parts"];
  const messages = [text("constraint", "user", "Keep this earlier constraint."), text("ack", "assistant", "Understood."), text("read", "user", "Read that file."),
    { id: "evidence", role: "assistant" as const, parts: [...evidence, { type: "text" as const, text: "Read it." }] }, text("follow-up", "user", "Use the evidence.")];
  assert.deepEqual(buildChatContext(messages, { maxTokens: 4_000, refillRatio: .3, toolRecords: { keepPreviousToolTurn: true } }).messages.map(message => message.id), messages.map(message => message.id));
  const eligible = messages.slice(0, 3).concat({ id: "terminal", role: "assistant", parts: [
    { type: "tool-checkTerminalCommand", toolCallId: "check", state: "output-available", input: {}, output: { newStdout: "x".repeat(48 * 1024), newStderr: "", status: "completed" } },
  ] }, messages.at(-1)!);
  assert.deepEqual(buildChatContext(eligible, { maxTokens: 6_000, toolRecords: { keepPreviousToolTurn: true } }).messages.map(message => message.id), eligible.map(message => message.id));
});

test("the same version and range of a document uses one body, but a different range or a folded source does not", async () => {
  const document = { documentId: "doc", contentHash: "revision-1", offset: 0, nextOffset: 24, text: "the same document excerpt", pages: [{ pageNumber: 1, offset: 0 }] };
  const doc = (id: string, value = document): ModelMessage[] => [
    { role: "assistant", content: [{ type: "tool-call", toolName: "readDocument", toolCallId: id, input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolName: "readDocument", toolCallId: id, output: { type: "json", value } }] },
  ];
  const messages: ModelMessage[] = [{ role: "user", content: "Read the report." }, ...doc("first"), ...doc("again"), ...doc("later", { ...document, offset: 25 }), ...doc("changed", { ...document, contentHash: "revision-2" }), ...doc("reparsed", { ...document, text: "The same document excerpt" })];
  const sent = results((await manager().prepare(messages)).messages).sent;
  assert.match(sent.get("first")!, /the same document excerpt/);
  assert.equal(JSON.parse(sent.get("again")!).toolCallId, "first");
  assert.match(sent.get("later")!, /the same document excerpt/);
  assert.match(sent.get("changed")!, /the same document excerpt/);
  assert.match(sent.get("reparsed")!, /The same document excerpt/);
  const folded = results((await manager({ state: "Read the report", calls: ["first"] }).prepare(messages)).messages).sent;
  assert.match(folded.get("again")!, /the same document excerpt/);
});
