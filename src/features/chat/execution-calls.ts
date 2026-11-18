import type { UIMessage } from "ai";
import type { RunView } from "@/lib/agent/runs";
import { isToolPart, type ToolPart } from "./page-utils";

/** `children`: a task sub-agent's own calls, recorded under the call that started it. */
export type ExecutionCall = { key: string; part?: ToolPart; step?: RunView["steps"][number]; children?: ExecutionCall[] };

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
  // A sub-agent's calls go inside the call that started it, in the order they ran.
  const byCallId = new Map(calls.flatMap(call => { const id = call.part?.toolCallId ?? call.step?.toolCallId; return id ? [[id, call] as const] : []; }));
  const nested = calls.filter(call => {
    const parent = call.step?.parentToolCallId ? byCallId.get(call.step.parentToolCallId) : undefined;
    if (!parent || parent === call) return true;
    (parent.children ??= []).push(call);
    return false;
  });
  return nested.reverse();
}
