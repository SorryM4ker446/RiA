import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assistantIdSchema, assistantSnapshotSchema } from "@/lib/assistants/schema";
import { documentSourceSchema } from "@/lib/documents/types";
import { documentDiagnosticsSchema } from "@/lib/documents/diagnostics";
import { MAX_DOCUMENT_SCOPE_LENGTH } from "@/lib/documents/scope";
import { modelRefSchema } from "@/lib/models/preferences-schema";
import type { ApprovalRule } from "@/lib/approvals/rules";

/*
 * Archives written while knowledge topics existed.
 *
 * Topics have been removed. An archive from before still restores: its
 * conversations come back as ordinary conversations, and each finished topic
 * result comes back as a conversation of its own. Nothing else of a topic is
 * kept. This module only reads those archives; nothing writes these shapes.
 */

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const date = z.iso.datetime();
const timestamps = { createdAt: date, updatedAt: date };

const topicConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(60), description: z.string().trim().max(500).default(""),
  collections: z.array(z.string().trim().min(1).max(40)).min(1).max(12).refine(names => new Set(names).size === names.length, "Duplicate collections"),
  assistantTemplateId: assistantIdSchema.nullable().default(null),
});

/** Fields a conversation carried while topics existed; read and dropped. */
export const legacyChatFields = {
  topicId: id.nullable().optional(),
  documentScope: z.string().max(MAX_DOCUMENT_SCOPE_LENGTH).optional(),
};

export const legacyTopicsSchema = z.array(z.strictObject({ id, config: topicConfigSchema, revision: z.number().int().positive(), ...timestamps })).max(50).default([]);

export const legacyResultsSchema = z.array(z.strictObject({
  id, topicId: id, requestHash: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(120), kind: z.enum(["report", "plan", "summary"]),
  topicRevision: z.number().int().positive(), status: z.enum(["generating", "ready", "needs_review", "failed", "cancelled", "interrupted"]),
  errorCode: z.string().max(60).nullable(), content: z.string().max(30_000).nullable(),
  metadata: z.strictObject({
    brief: z.string().max(2000), topic: topicConfigSchema, assistant: assistantSnapshotSchema.nullable(), model: modelRefSchema.nullable(),
    responseModelId: z.string().max(200).nullable(), sources: z.array(documentSourceSchema).max(8),
    diagnostics: documentDiagnosticsSchema.nullable(), unknownCitations: z.array(z.string().max(500)).max(16),
  }),
  ...timestamps,
})).max(200).default([]);

type LegacyTopics = z.infer<typeof legacyTopicsSchema>;
type LegacyResults = z.infer<typeof legacyResultsSchema>;

/** Whether an archived result has text to become a conversation; a failed or unfinished one has none. */
export const isFinishedResult = (result: { status: string; content?: string | null }) => Boolean(result.content) && ["ready", "needs_review"].includes(result.status);

/** Whether an archive's topic data hangs together: every result and conversation names a topic it holds. */
export function legacyTopicsConsistent(topics: LegacyTopics, results: LegacyResults, chats: Array<{ topicId?: string | null }>): boolean {
  const topicIds = new Set(topics.map(topic => topic.id));
  if (topicIds.size !== topics.length || new Set(results.map(result => result.id)).size !== results.length) return false;
  if (topics.some(topic => results.filter(result => result.topicId === topic.id).length > 50)) return false;
  return !chats.some(chat => chat.topicId && !topicIds.has(chat.topicId))
    && !results.some(result => !topicIds.has(result.topicId) || (["ready", "needs_review"].includes(result.status) && !result.content));
}

/**
 * Each finished result as a conversation named after its topic and title: its
 * brief as the user's message, the result as the answer. `links` rewrites the
 * document links in the answer to the restored documents.
 */
export function resultConversations(topics: LegacyTopics, results: LegacyResults, approvalRule: ApprovalRule, links: (text: string) => string) {
  const names = new Map(topics.map(topic => [topic.id, topic.config.name]));
  return results.filter(isFinishedResult).map(result => {
    const chatId = randomUUID();
    return {
      chat: { id: chatId, title: `${names.get(result.topicId) ?? ""} · ${result.title}`.slice(0, 200), approvalRule, createdAt: result.createdAt, updatedAt: result.updatedAt, lastMessageAt: result.updatedAt },
      messages: [
        { id: randomUUID(), chatId, role: "user" as const, content: result.metadata.brief || result.title, status: "success" as const, createdAt: result.createdAt },
        { id: randomUUID(), chatId, role: "assistant" as const, content: links(result.content!), status: "success" as const, createdAt: result.updatedAt },
      ],
    };
  });
}
