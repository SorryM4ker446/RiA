import { z } from "zod";
import type { UIMessage } from "ai";

/**
 * What a turn's reasoning is. `full` is the provider's reasoning text, `summary`
 * is only a summary of it, and `hidden` means the model reasoned but returned no
 * readable text. The interface says which, and never presents one as another.
 */
export const thinkingKinds = ["full", "summary", "hidden"] as const;
export type ThinkingKind = (typeof thinkingKinds)[number];

/** Where in the reasoning text the model stopped to call tools. */
const markSchema = z.object({ at: z.number().int().nonnegative(), tools: z.array(z.string().max(100)).max(64) });
export const thinkingRecordSchema = z.object({
  kind: z.enum(thinkingKinds),
  durationMs: z.number().int().nonnegative().optional(),
  marks: z.array(markSchema).max(256).optional(),
});
export type ThinkingRecord = z.infer<typeof thinkingRecordSchema>;

type ReasoningLike = { type: string; text?: unknown; providerMetadata?: unknown };

/** A provider that sent only summary details has not shown its reasoning itself. */
export function reasoningKindOf(parts: readonly ReasoningLike[]): "full" | "summary" | null {
  const reasoning = parts.filter(part => part.type === "reasoning" && typeof part.text === "string" && part.text.trim());
  if (!reasoning.length) return null;
  const types = reasoning.flatMap(part => {
    const details = (part.providerMetadata as { openrouter?: { reasoning_details?: unknown } } | undefined)?.openrouter?.reasoning_details;
    return Array.isArray(details) ? details.map(detail => (detail as { type?: unknown })?.type) : [];
  });
  return types.includes("reasoning.summary") && !types.includes("reasoning.text") ? "summary" : "full";
}

/** The tool calls between stretches of reasoning, as offsets into the trimmed text. */
export function thinkingMarks(parts: UIMessage["parts"]): NonNullable<ThinkingRecord["marks"]> {
  const marks: NonNullable<ThinkingRecord["marks"]> = [];
  let text = "";
  for (const part of parts) {
    if (part.type === "reasoning" && typeof part.text === "string") { text += part.text; continue; }
    const tool = part.type === "dynamic-tool" ? (part as { toolName?: string }).toolName : part.type.startsWith("tool-") ? part.type.slice(5) : null;
    if (!tool) continue;
    const at = text.trimStart().length;
    const last = marks.at(-1);
    if (last?.at === at) { if (!last.tools.includes(tool)) last.tools.push(tool); }
    else marks.push({ at, tools: [tool] });
  }
  return marks;
}

/** What to show for a message's reasoning, from what it stored or from its live parts. */
export function readThinking(message: UIMessage) {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const stored = thinkingRecordSchema.safeParse((message.metadata as { thinking?: unknown } | undefined)?.thinking);
  const text = parts.flatMap(part => part.type === "reasoning" && typeof part.text === "string" ? [part.text] : []).join("").trim();
  if (!text) return stored.success && stored.data.kind === "hidden" ? { kind: "hidden" as const, text: "", segments: [], durationMs: stored.data.durationMs } : null;
  const marks = stored.success && stored.data.marks ? stored.data.marks : thinkingMarks(parts);
  const segments: { text: string; tools: string[] }[] = [];
  let from = 0;
  for (const mark of marks) {
    const at = Math.min(mark.at, text.length);
    segments.push({ text: text.slice(from, at).trim(), tools: mark.tools });
    from = at;
  }
  const rest = text.slice(from).trim();
  if (rest) segments.push({ text: rest, tools: [] });
  const kind: ThinkingKind = stored.success && stored.data.kind !== "hidden" ? stored.data.kind : reasoningKindOf(parts) ?? "full";
  return { kind, text, segments, durationMs: stored.success ? stored.data.durationMs : undefined };
}

/**
 * Times a turn's reasoning across its steps. A step's reasoning starts when the
 * request goes out and ends with its last reasoning text; with no readable text
 * it ends where the output begins. A step that did not reason adds nothing.
 */
export function createThinkingClock(now: () => number = Date.now, earlier?: Pick<ThinkingRecord, "kind" | "durationMs">) {
  let total = earlier?.durationMs ?? 0, kind: ThinkingKind | null = earlier?.kind ?? null;
  let started: number | null = null, lastReasoning: number | null = null, firstOutput: number | null = null;
  return {
    stepStarted() { started = now(); lastReasoning = null; firstOutput = null; },
    reasoning() { lastReasoning = now(); },
    output() { firstOutput ??= now(); },
    stepFinished(step: { reasoning: readonly ReasoningLike[]; hiddenReasoning: boolean }) {
      if (started === null) return;
      const shown = reasoningKindOf(step.reasoning.map(part => ({ ...part, type: "reasoning" })));
      if (shown) {
        total += Math.max(0, (lastReasoning ?? now()) - started);
        kind = kind === "full" || shown === "full" ? "full" : "summary";
      } else if (step.hiddenReasoning) {
        total += Math.max(0, (firstOutput ?? now()) - started);
        kind ??= "hidden";
      }
      started = null;
    },
    /** Null when nothing was reasoned, so a plain answer records nothing about it. */
    report(): Pick<ThinkingRecord, "kind" | "durationMs"> | null {
      return kind ? { kind, durationMs: Math.round(total) } : null;
    },
  };
}
