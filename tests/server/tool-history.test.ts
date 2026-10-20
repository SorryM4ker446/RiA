import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToModelMessages, type UIMessage } from "ai";
import { historicalToolText, historyTextExcerpt, TOOL_HISTORY_CHARACTERS } from "@/lib/chat/tool-history";
import { buildChatContext, historicalText } from "@/lib/chat/context";

function terminal(overrides: Record<string, unknown> = {}): UIMessage["parts"][number] {
  return { type: "tool-runTerminalCommand", toolCallId: "compiler-call", state: "output-available",
    input: { grantId: "folder", command: "# begin\n" + "# padding\n".repeat(100_000) + "Write-Output 'end'", binding: { cwd: "C:\\project" } },
    output: { status: "failed", exitCode: 2, truncated: false,
      stdout: "build started\n" + "ordinary progress\n".repeat(1000) + "src/main.cpp:42: error: missing symbol\n" + "ordinary progress\n".repeat(1000) + "Tests: 34 passed, 2 failed\n",
      stderr: "compiler diagnostic details", fileChanges: { complete: true, files: [{ path: "src/main.cpp", kind: "modified" }] },
    }, ...overrides,
  } as UIMessage["parts"][number];
}

test("long commands cannot displace terminal outcomes, middle diagnostics, test summaries or file changes", () => {
  const part = terminal();
  const before = structuredClone(part);
  const text = historicalToolText(part);
  assert.ok(text.length <= TOOL_HISTORY_CHARACTERS);
  assert.match(text, /"status":"failed"/);
  assert.match(text, /"exitCode":2/);
  assert.match(text, /"capturedOutputTruncated":false/);
  assert.match(text, /src\/main\.cpp:42: error: missing symbol/);
  assert.match(text, /Tests: 34 passed, 2 failed/);
  assert.match(text, /compiler diagnostic details/);
  assert.match(text, /modified: src\/main\.cpp/);
  assert.match(text, /\[truncated\]/);
  assert.deepEqual(part, before);
});

test("terminal excerpts retain captured stream ends and declare incomplete file observations", () => {
  const text = historicalToolText(terminal({ output: {
    status: "completed", exitCode: 0, truncated: true,
    stdout: "stdout-start\n" + "noise\n".repeat(5000) + "stdout-end",
    stderr: "stderr-start\n" + "noise\n".repeat(5000) + "stderr-end",
    fileChanges: { complete: false, files: Array.from({ length: 20 }, (_, i) => ({ path: `file-${i}.ts`, kind: i === 19 ? "deleted" : "created" })) },
  } }));
  for (const value of ["stdout-start", "stdout-end", "stderr-start", "stderr-end", '"exitCode":0', '"capturedOutputTruncated":true', "captureComplete=false", "reportedFiles=20", "omittedFromHistory=15", "created: file-0.ts", "deleted: file-19.ts"]) assert.ok(text.includes(value), value);
  assert.ok(text.length <= TOOL_HISTORY_CHARACTERS);
});

test("empty, stopped and failed historical calls never invent successful execution", () => {
  const stopped = historicalToolText(terminal({ output: { status: "stopped", exitCode: null, stdout: "EXIT=0\n--- run sample ---", stderr: "", truncated: false } }));
  assert.match(stopped, /"status":"stopped"/);
  assert.match(stopped, /"exitCode":null/);
  assert.doesNotMatch(stopped, /"status":"completed"/);
  const failed = historicalToolText(terminal({ state: "output-error", output: undefined, errorText: "Access was revoked" }));
  assert.match(failed, /Access was revoked/);
  assert.match(failed, /"state":"output-error"/);
  const empty = historicalToolText(terminal({ output: undefined, input: undefined, state: "input-available" }));
  assert.doesNotMatch(empty, /exitCode|completed|failed/);
});

test("generic and dynamic tool records prioritize output and errors over large input", () => {
  for (const type of ["tool-writeLocalFile", "dynamic-tool"] as const) {
    const part = { type, toolName: "extension-build", toolCallId: "external-call", state: "output-available", input: { content: "long input".repeat(100_000) }, output: { status: "failed", error: "Required template missing" } } as UIMessage["parts"][number];
    const text = historicalToolText(part);
    assert.match(text, /Required template missing/);
    assert.ok(text.indexOf("output (excerpt)") < text.indexOf("input (excerpt)"));
    assert.ok(text.length <= TOOL_HISTORY_CHARACTERS);
  }
});

test("small history budgets retain the latest tool outcome instead of an earlier command prefix", () => {
  const message: UIMessage = { id: "answer", role: "assistant", parts: [
    ...Array.from({ length: 8 }, (_, i) => terminal({ toolCallId: `old-${i}`, output: { status: "completed", exitCode: 0, stdout: `old result ${i}` } })),
    terminal(), { type: "text", text: "assistant commentary ".repeat(1000) },
  ] };
  for (const budget of [0, 100, 500, 1500]) {
    const excerpt = historicalText(message, budget);
    assert.ok(excerpt.length <= budget);
    if (budget >= 500) {
      assert.match(excerpt, /"exitCode":2/);
      assert.match(excerpt, /missing symbol/);
      assert.match(excerpt, /earlier tool calls omitted/);
    }
  }
  const history = buildChatContext([
    { id: "question", role: "user", parts: [{ type: "text", text: "Build the app" }] }, message,
    { id: "next", role: "user", parts: [{ type: "text", text: "Explain the failure" }] },
  ], { maxMessages: 2 });
  assert.match(history.historyExcerpt, /"exitCode":2/);
  assert.match(history.historyExcerpt, /missing symbol/);
});

test("Unicode and escaping survive bounded excerpts without splitting surrogate pairs", () => {
  const source = "开头🙂\"\n" + "中间🙂\\".repeat(5000) + "末尾🙂";
  const excerpt = historyTextExcerpt(source, 200);
  assert.ok(excerpt.length <= 200);
  assert.match(excerpt, /^开头🙂/);
  assert.match(excerpt, /末尾🙂$/);
  assert.equal(Buffer.from(excerpt, "utf8").toString("utf8"), excerpt);
});

test("active approval retains its complete command and reasoning through model conversion", async () => {
  const command = "# begin\n" + "# exact command\n".repeat(10_000) + "Write-Output 'end'";
  const reasoning = "r".repeat(141_815);
  const messages: UIMessage[] = [
    { id: "user", role: "user", parts: [{ type: "text", text: "Run the approved command" }] },
    { id: "approval", role: "assistant", parts: [
      { type: "reasoning", text: reasoning, state: "done" },
      { type: "tool-runTerminalCommand", toolCallId: "active-call", state: "approval-responded", input: { grantId: "folder", command }, approval: { id: "decision", approved: true } } as UIMessage["parts"][number],
    ] },
  ];
  const context = buildChatContext(messages);
  assert.deepEqual(context.messages, messages);
  const model = await convertToModelMessages(context.messages);
  const serialized = JSON.stringify(model);
  assert.ok(serialized.includes(JSON.stringify(command)));
  assert.ok(serialized.includes(reasoning));
});
