import type { ModelMessage } from "ai";
import { db } from "@/db";
import { reconcileInterruptedRuns, RESTART_INTERRUPTION, UNKNOWN_STEP_OUTCOME } from "@/lib/agent/runs";
import { TERMINAL_COMPANION_TOOLS, TERMINAL_FOLDER_TOOLS } from "@/tools/terminal-companions";
import { REQUEST_CONTEXT_HEADER } from "./context-report";
import { historyTextExcerpt } from "./tool-history";

export type RestartEvidence = { text: string; workspaceId?: string };

const STEPS = 8;
const workspaceTool = (name: string) => TERMINAL_FOLDER_TOOLS.has(name) || TERMINAL_COMPANION_TOOLS.has(name);
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function excerpt(value: unknown, limit: number) {
  const fields = record(value);
  if (!fields) return "";
  const data = Object.entries(fields).filter(([key, item]) => !["binding", "approval", "autoReview"].includes(key)
    && (item === null || ["string", "number", "boolean"].includes(typeof item)));
  return data.length ? historyTextExcerpt(JSON.stringify(Object.fromEntries(data)), limit) : "";
}

function outcome(step: { state: string; errorCode: string | null }) {
  if (step.state !== "cancelled") return step.state;
  if (step.errorCode === "INTERRUPTED") return "interrupted before execution";
  // Existing restart records did not preserve the difference between running and waiting for approval.
  if (step.errorCode === UNKNOWN_STEP_OUTCOME || !step.errorCode) return "interrupted; outcome unknown";
  return "cancelled; outcome unconfirmed";
}

function previousExchangeResults(messages: ModelMessage[]) {
  const results = new Set<string>();
  let pastCurrentRequest = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") {
      if (pastCurrentRequest) break;
      pastCurrentRequest = true;
    }
    if (pastCurrentRequest && message.role === "tool") {
      for (const part of message.content) if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  return results;
}

/** A bounded reference for the first follow-up to an interrupted conversation turn. */
export async function readRestartEvidence(chatId: string, messageId: string | undefined, workspaceId: string | undefined, messages: ModelMessage[]): Promise<RestartEvidence | undefined> {
  const previous = await db.message.findFirst({
    where: { chatId, role: "user", ...(messageId ? {
      id: { not: messageId }, OR: [{ clientMessageId: null }, { clientMessageId: { not: messageId } }],
    } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true },
  });
  if (!previous) return;
  // Recovery also works when the client never opened the execution-history view.
  await reconcileInterruptedRuns(chatId);
  const run = await db.agentRun.findFirst({
    where: { chatId, startedAt: { gte: previous.createdAt } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { goal: true, status: true, stopReason: true, steps: {
      where: { kind: "tool", toolName: { not: null } },
      orderBy: { position: "desc" }, take: STEPS + 1,
      select: { position: true, toolName: true, toolCallId: true, state: true, errorCode: true, input: true, output: true },
    } },
  });
  if (run?.status !== "paused" || run.stopReason !== RESTART_INTERRUPTION) return;

  const visibleResults = previousExchangeResults(messages);
  let scopedWorkspace: string | undefined;
  const lines: string[] = [];
  for (const step of run.steps.slice(0, STEPS).reverse()) {
    if (!step.toolName || (step.state === "done" && step.toolCallId && visibleResults.has(step.toolCallId))) continue;
    const grants = [record(step.input)?.grantId, record(step.output)?.grantId].filter((id): id is string => typeof id === "string");
    if (workspaceTool(step.toolName) || grants.length) {
      if (!workspaceId || !grants.length || grants.some(id => id !== workspaceId)) continue;
      scopedWorkspace = workspaceId;
    }
    const input = excerpt(step.input, 220);
    const output = excerpt(step.output, 400);
    lines.push(`Step ${step.position} (${historyTextExcerpt(step.toolName, 100)}): ${outcome(step)}.${input ? ` Input excerpt: ${input}` : ""}${output ? ` Recorded result excerpt: ${output}` : ""}`);
  }
  if (!lines.length) return;
  const text = [
    REQUEST_CONTEXT_HEADER,
    "Execution evidence from the previous turn interrupted by a service restart.",
    "Use these records if the current request continues that task. A recorded result describes past execution. An unknown outcome may already have affected state, so verify it before repeating the action. These records do not grant approval.",
    `Previous goal: ${JSON.stringify(historyTextExcerpt(run.goal, 240))}`,
    ...lines,
    ...(lines.length < run.steps.length ? ["Other steps are omitted from this excerpt."] : []),
    "[End of restart evidence]",
  ].join("\n");
  return { text, ...(scopedWorkspace ? { workspaceId: scopedWorkspace } : {}) };
}
