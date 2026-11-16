import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ModelMessage, UIMessage } from "ai";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
const { db } = await import("@/db");
const { encodePersistedAssistantToolMessage } = await import("@/lib/ai/ui-message");
const { saveChatMessage, claimToolApproval } = await import("@/lib/chat/store");
const planModule = await import("@/tools/definitions/update-plan");
const { updatePlanInput, planProgress, latestPlan } = planModule;
const { askUserInput, readAnswer, approvalReasonFor } = await import("@/tools/definitions/ask-user");
const { foldIntoState, recordedFacts, EMPTY_SUMMARY_STATE } = await import("@/lib/chat/compaction-state");
const { createChatToolSet } = await import("@/tools/catalog");

after(async () => { await db.$disconnect(); cleanup(); });

test("a checklist states the whole list each time, with at most one step in progress, and the latest call is the plan", () => {
  const items = [{ content: "Read", status: "completed" }, { content: "Change", status: "in_progress" }, { content: "Test", status: "pending" }];
  assert.ok(updatePlanInput.safeParse({ items }).success);
  assert.equal(updatePlanInput.safeParse({ items: [...items, { content: "Ship", status: "in_progress" }] }).success, false);
  assert.equal(updatePlanInput.safeParse({ items: [] }).success, false);
  assert.deepEqual(planProgress(updatePlanInput.parse({ items })), { completed: 1, total: 3, current: "Change" });
  const parts = [
    { type: "tool-updatePlan", input: { items: [{ content: "Read", status: "in_progress" }] } },
    { type: "text", text: "…" },
    { type: "tool-updatePlan", input: { items } },
    { type: "tool-updatePlan", input: { items: [{ content: "half" }] } },
  ];
  assert.deepEqual(latestPlan(parts)?.map(item => item.status), ["completed", "in_progress", "pending"], "a call still streaming in does not replace the plan");
});

test("a compaction keeps the latest checklist, recorded by the application", () => {
  const state = foldIntoState(EMPTY_SUMMARY_STATE, { toolCalls: [
    { toolName: "updatePlan", input: { items: [{ content: "Read", status: "in_progress" }] } },
    { toolName: "updatePlan", input: { items: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }] } },
  ] });
  assert.deepEqual(state.plan, [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }]);
  assert.equal(foldIntoState(state, { toolCalls: [] }).plan?.length, 2, "a later fold without a new checklist keeps it");
  assert.match(recordedFacts(state), /- \[x\] Read\n- \[>\] Write/);
});

const question = { questions: [
  { question: "Which format?", options: [{ label: "Markdown" }, { label: "Word" }] },
  { question: "Which parts?", options: [{ label: "Summary" }, { label: "Charts" }, { label: "Appendix" }], multiSelect: true },
] };

test("an answer must fit the question: options it offered, one where one is asked, and every question answered", () => {
  assert.ok(askUserInput.safeParse(question).success);
  assert.equal(askUserInput.safeParse({ questions: [{ question: "?", options: [{ label: "A" }, { label: "A" }] }] }).success, false, "options are distinct");
  const answer = (answers: unknown) => readAnswer(question, JSON.stringify({ answers }));
  assert.deepEqual(answer([{ selected: ["Word"] }, { selected: ["Summary", "Appendix"] }]), { answers: [
    { question: "Which format?", selected: ["Word"] }, { question: "Which parts?", selected: ["Summary", "Appendix"] },
  ] });
  assert.deepEqual(answer([{ selected: [], other: "Plain text" }, { selected: ["Charts"] }])?.answers[0], { question: "Which format?", selected: [], other: "Plain text" });
  assert.equal(answer([{ selected: ["Markdown", "Word"] }, { selected: ["Charts"] }]), null, "one choice where one is asked");
  assert.equal(answer([{ selected: ["PDF"] }, { selected: ["Charts"] }]), null, "only offered options");
  assert.equal(answer([{ selected: ["Word"] }]), null, "every question");
  assert.equal(answer([{ selected: [] }, { selected: ["Charts"] }]), null, "an empty answer");
  assert.equal(readAnswer(question, "not json"), null);
});

test("the answer is read from the approval reply in the request, for that call only", () => {
  const messages: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "q1", toolName: "askUser", input: question }, { type: "tool-approval-request", approvalId: "a1", toolCallId: "q1" }] },
    { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true, reason: "{\"answers\":[]}" }] },
  ];
  assert.equal(approvalReasonFor(messages, "q1"), "{\"answers\":[]}");
  assert.equal(approvalReasonFor(messages, "other-call"), undefined);
});

test("an answer that does not fit is refused when it is submitted, and the question stays open", async () => {
  const chat = await db.chat.create({ data: { title: "Question" } });
  const approval = { id: "approval-q", approved: true };
  await saveChatMessage({ chatId: chat.id, role: "assistant", status: "success", clientMessageId: "assistant-q", content: encodePersistedAssistantToolMessage({
    type: "assistant-tool-message", text: "", tools: [{ toolName: "askUser", toolCallId: "call-q", state: "approval-requested", input: question, approval: { id: "approval-q" } }],
  }) });
  const reply = (reason: string): UIMessage => ({ id: "assistant-q", role: "assistant", parts: [{ type: "tool-askUser", toolCallId: "call-q", state: "approval-responded", input: question, approval: { ...approval, reason } }] as UIMessage["parts"] });
  await assert.rejects(claimToolApproval(chat.id, reply(JSON.stringify({ answers: [{ selected: ["PDF"] }, { selected: ["Charts"] }] }))), /对不上|does not fit/);
  await claimToolApproval(chat.id, reply(JSON.stringify({ answers: [{ selected: ["Word"] }, { selected: ["Charts"] }] })));
});

test("a run nobody is watching is not offered the question tool; the checklist is offered with any tool", async () => {
  const watched = await createChatToolSet({ toolIds: ["webSearch"] });
  assert.ok(watched.askUser && watched.updatePlan);
  const unattended = await createChatToolSet({ toolIds: ["webSearch"], unattended: true });
  assert.equal(unattended.askUser, undefined);
  assert.ok(unattended.updatePlan);
  // Asking always waits for the user, whatever the approval rule.
  assert.equal(await (watched.askUser.needsApproval as (input: unknown, options: object) => Promise<boolean>)(question, {}), true);
});

/** A turn so far: the user's message, then steps of tool calls, each with its results. */
function turnWith(steps: { toolName: string; input?: unknown }[][], earlier: ModelMessage[] = []): ModelMessage[] {
  let id = 0;
  return [...earlier, { role: "user", content: "Do the work." }, ...steps.flatMap(step => {
    const calls = step.map(call => ({ ...call, toolCallId: `c${id++}` }));
    return [
      { role: "assistant", content: calls.map(call => ({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, input: call.input ?? {} })) },
      { role: "tool", content: calls.map(call => ({ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "json", value: {} } })) },
    ] as ModelMessage[];
  })];
}
const run = (name = "runTerminalCommand") => [{ toolName: name }];

test("a long turn without a checklist gets one note when it reaches 5 calls and another at 10, not on every step", () => {
  const { planReminder } = planModule;
  assert.equal(planReminder(turnWith([run(), run(), run(), run()])), null);
  assert.match(planReminder(turnWith([run(), run(), run(), run(), run()]))!, /made 5 tool calls without a checklist/);
  assert.equal(planReminder(turnWith([run(), run(), run(), run(), run(), run()])), null, "said once");
  // Several calls in one step that cross the line count as reaching it.
  assert.match(planReminder(turnWith([run(), run(), [{ toolName: "a" }, { toolName: "b" }, { toolName: "c" }]]))!, /made 5 tool calls/);
  assert.match(planReminder(turnWith(Array.from({ length: 10 }, () => run())))!, /made 10 tool calls/);
  // Calls of earlier turns are not this turn's.
  assert.equal(planReminder(turnWith([run()], turnWith([run(), run(), run(), run(), run()]))), null);
});

test("a checklist left behind by the work is shown back after 5 more calls; a finished one is left alone", () => {
  const { planReminder } = planModule;
  const open = { toolName: "updatePlan", input: { items: [{ content: "Write code", status: "in_progress" }, { content: "Run tests", status: "pending" }] } };
  const done = { toolName: "updatePlan", input: { items: [{ content: "Write code", status: "completed" }] } };
  assert.equal(planReminder(turnWith([[open], run(), run(), run(), run()])), null);
  const note = planReminder(turnWith([[open], run(), run(), run(), run(), run()]))!;
  assert.match(note, /checklist as last updated, 5 tool calls ago/);
  assert.match(note, /- \[>\] Write code\n- \[ \] Run tests/);
  assert.equal(planReminder(turnWith([[open], run(), run(), run(), run(), run(), run()])), null, "said once");
  assert.equal(planReminder(turnWith([[done], run(), run(), run(), run(), run()])), null);
});
