import type { UIMessage } from "ai";
import type { RunView } from "@/lib/agent/runs";
import { isToolPart, type ToolPart } from "./page-utils";

export type ExecutionCall = { key: string; part?: ToolPart; step?: RunView["steps"][number] };

/** Enrich only exact call identities within an already linked request. */
export function executionCalls(run?: RunView, message?: UIMessage): ExecutionCall[] {
  const parts = message?.parts.filter(isToolPart) ?? [];
  const steps = run?.steps ?? [];
  // Old steps have no call identity. A safely linked full message can stand on
  // its own, but its calls must never be paired by name or array position.
  if (!steps.length || (parts.length && steps.every(step => !step.toolCallId))) {
    return parts.map(part => ({ key: `call:${part.toolCallId}`, part })).reverse();
  }
  const byId = new Map(parts.map(part => [part.toolCallId, part]));
  const attached = new Set<string>();
  const calls: ExecutionCall[] = steps.map(step => {
    const part = step.toolCallId ? byId.get(step.toolCallId) : undefined;
    if (part) attached.add(part.toolCallId);
    return { key: step.toolCallId ? `call:${step.toolCallId}` : `step:${step.id}`, step, part };
  });
  for (const part of parts) {
    if (!attached.has(part.toolCallId)) calls.push({ key: `call:${part.toolCallId}`, part });
  }
  return calls.reverse();
}
