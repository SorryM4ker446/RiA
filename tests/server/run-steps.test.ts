import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import type { ToolExecutionOptions } from "ai";
import { createTestDatabase } from "../helpers/database";

const cleanup = createTestDatabase();
process.env.PRIVATE_AI_TEST_PROVIDER = "1";
const { db } = await import("@/db");
const { startRun } = await import("@/lib/agent/runs");
const { createChatToolSet, getToolDescriptor } = await import("@/tools/catalog");

function resetLimits() { globalThis.__privateAiRateLimitStore.clear(); }

beforeEach(async (t: TestContext) => {
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  process.env.OPENROUTER_API_KEY = "offline-fixture-placeholder";
  // The wrapper checks the tool quota before it does anything else, so a quota
  // left spent by an earlier test would make these tests measure the rate limit
  // instead of the step record.
  resetLimits();
  await db.task.deleteMany({});
  await db.agentStep.deleteMany({});
  await db.agentRun.deleteMany({});
});
after(async () => { await db.$disconnect(); cleanup(); });

// These tests drive the wrapper directly rather than through the model loop, and
// none of them read the per-call execution context.
const toolOptions = {} as ToolExecutionOptions;

function stepsOf(runId: string) {
  return db.agentStep.findMany({ where: { runId }, orderBy: { position: "asc" } });
}

/**
 * A loopback stand-in for Tavily, so the search tool genuinely runs without a
 * billed request. Configuring it is also what makes `webSearch` available, which
 * is what the budget and mid-turn unavailability paths need in order to be
 * reachable at all.
 */
async function withLocalSearchServer(run) {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ query: "steps", request_id: "local", response_time: 0.01, images: [], results: [{ title: "Local fixture", url: "https://example.invalid/steps", content: "fixture", score: 1 }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previousKey = process.env.TAVILY_API_KEY;
  const previousUrl = process.env.TAVILY_SEARCH_URL;
  process.env.TAVILY_API_KEY = "local-step-fixture";
  process.env.TAVILY_SEARCH_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`;
  try {
    return await run();
  } finally {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.TAVILY_SEARCH_URL; else process.env.TAVILY_SEARCH_URL = previousUrl;
    await new Promise(resolve => server.close(resolve));
  }
}

test("a step whose tool ran is recorded as done and is not re-settled on the way out", async () => {
  const run = await startRun({ chatId: null, goal: "记录一次成功执行" });
  const tools = await createChatToolSet({ toolIds: ["createTask"], runId: run.id });
  await tools.createTask.execute({ title: "买牛奶" }, toolOptions);

  const steps = await stepsOf(run.id);
  assert.equal(steps.length, 1);
  // Awaiting the call means the wrapper's `finally` has already run, so this
  // also proves the final settlement does not overwrite a state that was
  // already committed — the guard, not luck, is what keeps it "done".
  assert.equal(steps[0].state, "done");
  assert.ok(steps[0].finishedAt, "a settled step carries a finished timestamp");
});

test("a step whose tool throws is recorded as failed and the error still propagates", async (t: TestContext) => {
  const descriptor = getToolDescriptor("createTask");
  t.mock.method(descriptor, "execute", async () => { throw new Error("tool exploded"); });

  const run = await startRun({ chatId: null, goal: "记录一次失败执行" });
  const tools = await createChatToolSet({ toolIds: ["createTask"], runId: run.id });
  await assert.rejects(tools.createTask.execute({ title: "会失败" }, toolOptions), /tool exploded/);

  const steps = await stepsOf(run.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].state, "failed");
  assert.equal(steps[0].errorCode, "INTERNAL_ERROR");
  assert.ok(steps[0].finishedAt);
});

test("a step refused by the per-turn result budget is recorded as skipped, not as running", async () => {
  const run = await startRun({ chatId: null, goal: "结果预算被用尽" });
  await withLocalSearchServer(async () => {
    const tools = await createChatToolSet({ toolIds: ["webSearch"], runId: run.id });
    // The first call spends the whole per-turn budget, so the second is the one
    // that returns early from the budget branch.
    await tools.webSearch.execute({ query: "first", maxResults: 10 }, toolOptions);
    const refused = await tools.webSearch.execute({ query: "second", maxResults: 5 }, toolOptions);
    assert.equal(refused.skipped, "resultBudget");
  });

  const steps = await stepsOf(run.id);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].state, "done");
  // The early return produced a usable tool output, but the tool never ran, so
  // the step is skipped rather than done.
  assert.equal(steps[1].state, "skipped");
  assert.ok(steps[1].finishedAt);
  assert.equal(steps.filter((step) => step.state === "running").length, 0);
});

test("a step whose tool is no longer configured is recorded as skipped", async () => {
  const run = await startRun({ chatId: null, goal: "工具在执行前失效" });
  await withLocalSearchServer(async () => {
    const tools = await createChatToolSet({ toolIds: ["webSearch"], runId: run.id });
    // The tool set is built while the tool is configured; the key disappears
    // before the call, which is the mid-turn unavailability the wrapper handles.
    process.env.TAVILY_API_KEY = "";
    const refused = await tools.webSearch.execute({ query: "gone", maxResults: 3 }, toolOptions);
    assert.equal(refused.skipped, "notConfigured");
  });

  const steps = await stepsOf(run.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].state, "skipped");
  assert.ok(steps[0].finishedAt);
});

test("a turn leaves no step still running once every exit has been taken", async () => {
  const run = await startRun({ chatId: null, goal: "走到每一个出口" });
  await withLocalSearchServer(async () => {
    // One tool set for the whole run, which is how the turn is built in
    // practice: the wrapper's step position counter is per tool set, and a
    // second set for the same run would restart it against the unique
    // (runId, position) index.
    const tools = await createChatToolSet({ toolIds: ["createTask", "webSearch"], runId: run.id });
    await tools.createTask.execute({ title: "成功的一步" }, toolOptions);

    const descriptor = getToolDescriptor("createTask");
    const original = descriptor.execute;
    descriptor.execute = async () => { throw new Error("tool exploded"); };
    try {
      await assert.rejects(tools.createTask.execute({ title: "失败的一步" }, toolOptions), /tool exploded/);
    } finally {
      descriptor.execute = original;
    }

    await tools.webSearch.execute({ query: "one", maxResults: 10 }, toolOptions);
    await tools.webSearch.execute({ query: "two", maxResults: 5 }, toolOptions);
  });

  const steps = await stepsOf(run.id);
  const states = steps.map((step) => step.state).sort();
  assert.deepEqual(states, ["done", "done", "failed", "skipped"]);
  // This is the invariant the budget depends on: `checkRunAllowance` counts step
  // rows, so a step left "running" would spend budget forever and would be shown
  // in the run record as work that never ended.
  assert.equal(steps.filter((step) => step.state === "running").length, 0);
  assert.equal(steps.filter((step) => step.finishedAt === null).length, 0);
});
