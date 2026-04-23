import { db } from "@/db";
import { truncateTitle } from "@/lib/ai/ui-message";
import { saveMemory } from "@/lib/memory/store";
import {
  getToolDescriptor,
  type ToolExecutionState,
  type ToolMemoryDraft,
  type ToolTriggerType,
} from "@/tools/catalog";

const TOOL_MEMORY_VERSION = "tool-memory-v1";
const MEMORY_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";

type PersistToolMemoryParams = {
  userId: string;
  toolId: string;
  trigger: ToolTriggerType;
  state: ToolExecutionState | string;
  input: unknown;
  output: unknown;
  assistantText: string;
  modelId?: string;
  invokedAt?: Date;
};

type PersistToolMemoryResult = {
  written: boolean;
  key?: string;
  reason:
    | "written"
    | "tool-not-found"
    | "state-not-available"
    | "policy-disabled"
    | "summary-empty"
    | "quality-too-low"
    | "deduped";
};

function normalizeSeed(seed: string): string {
  const normalized = seed.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return "entry";
  return normalized
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
}

function buildMemoryKey(toolId: string, draft: ToolMemoryDraft): string {
  return truncateTitle(`tool:${toolId}:${normalizeSeed(draft.seed) || "entry"}`, 60);
}

function buildMemoryValue(params: {
  toolId: string;
  trigger: ToolTriggerType;
  assistantText: string;
  draft: ToolMemoryDraft;
  fingerprint: string;
  invokedAt: Date;
}): string {
  const assistant = params.assistantText.replace(/\s+/g, " ").trim();
  const lines = [
    `version=${TOOL_MEMORY_VERSION}`,
    `tool=${params.toolId}`,
    `trigger=${params.trigger}`,
    `time=${params.invokedAt.toISOString()}`,
    `fingerprint=${params.fingerprint}`,
    `quality=${params.draft.quality.toFixed(3)}`,
    `summary=${params.draft.summary}`,
  ];

  if (params.draft.tags?.length) {
    lines.push(`tags=${params.draft.tags.join(",")}`);
  }

  if (assistant) {
    lines.push(`assistant=${assistant.slice(0, 260)}`);
  }

  return lines.join("\n");
}

function buildFingerprint(params: {
  toolId: string;
  trigger: ToolTriggerType;
  draft: ToolMemoryDraft;
}): string {
  const tags = (params.draft.tags ?? []).join(",");
  const normalized = [
    params.toolId,
    params.trigger,
    params.draft.seed.trim().toLowerCase(),
    params.draft.summary.trim().toLowerCase(),
    tags.trim().toLowerCase(),
  ].join("::");

  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function readFingerprint(value: string): string | null {
  const match = /^fingerprint=(.+)$/m.exec(value);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function logMemoryDecision(payload: Record<string, unknown>) {
  if (TOOL_DEBUG) {
    console.info("tool.memory.decision", payload);
  }
}

export async function persistToolMemory(params: PersistToolMemoryParams): Promise<PersistToolMemoryResult> {
  const descriptor = getToolDescriptor(params.toolId);
  if (!descriptor) {
    return { written: false, reason: "tool-not-found" };
  }

  if (params.state !== "output-available") {
    return { written: false, reason: "state-not-available" };
  }

  if (!descriptor.memory.enabled) {
    return { written: false, reason: "policy-disabled" };
  }

  const draft = descriptor.memory.summarize({
    input: params.input,
    output: params.output,
    assistantText: params.assistantText,
    trigger: params.trigger,
    modelId: params.modelId,
  });

  if (!draft || !draft.summary.trim()) {
    return { written: false, reason: "summary-empty" };
  }

  if (draft.quality < descriptor.memory.minQuality) {
    return { written: false, reason: "quality-too-low" };
  }

  const invokedAt = params.invokedAt ?? new Date();
  const key = buildMemoryKey(params.toolId, draft);
  const fingerprint = buildFingerprint({
    toolId: params.toolId,
    trigger: params.trigger,
    draft,
  });
  const value = buildMemoryValue({
    toolId: params.toolId,
    trigger: params.trigger,
    assistantText: params.assistantText,
    draft,
    fingerprint,
    invokedAt,
  });

  const existing = await db.memory.findFirst({
    where: {
      userId: params.userId,
      key,
    },
    select: {
      id: true,
      value: true,
      updatedAt: true,
    },
  });

  const existingFingerprint = existing ? readFingerprint(existing.value) : null;
  if (
    existing &&
    existingFingerprint === fingerprint &&
    Date.now() - existing.updatedAt.getTime() < MEMORY_DEDUPE_WINDOW_MS
  ) {
    logMemoryDecision({
      toolId: params.toolId,
      trigger: params.trigger,
      key,
      fingerprint,
      written: false,
      reason: "deduped",
    });
    return { written: false, key, reason: "deduped" };
  }

  await saveMemory({
    userId: params.userId,
    key,
    value,
    score: Math.max(0, Math.min(1, draft.score)),
  });

  logMemoryDecision({
    toolId: params.toolId,
    trigger: params.trigger,
    key,
    quality: draft.quality,
    score: draft.score,
    written: true,
    reason: "written",
  });

  return {
    written: true,
    key,
    reason: "written",
  };
}
