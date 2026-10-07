import { z } from "zod";
import { generationRecipeSchema } from "@/lib/media/generation-recipe";
import { documentPagesSchema } from "@/lib/documents/types";
import { MAX_DOCUMENT_SCOPE_LENGTH, decodeDocumentScope } from "@/lib/documents/scope";
import { legacyPreferencesSchema, preferencesSchema, providerAgnosticPreferencesSchema, providerIdSchema } from "@/lib/models/preferences-schema";
import { eventSchema, factsSchema } from "@/lib/activity/types";

export const BACKUP_LIMITS = { bytes: 512 * 1024 * 1024, manifest: 32 * 1024 * 1024, chunk: 8 * 1024 * 1024, rows: 10_000, stagingAgeMs: 60 * 60_000 };
export const backupId = z.string().uuid();
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const date = z.iso.datetime();
const count = z.number().int().nonnegative();
const text = z.string().max(2 * 1024 * 1024);
const timestamps = { createdAt: date, updatedAt: date };
const message = z.strictObject({ id, chatId: id, clientMessageId: id.nullable(), role: z.enum(["user", "assistant", "system"]), content: text, status: z.enum(["pending", "success", "error"]), createdAt: date });
const storedScope = z.string().max(MAX_DOCUMENT_SCOPE_LENGTH).refine(value => {
  try { decodeDocumentScope(value); return true; } catch { return false; }
}, "Invalid document collection scope");
const chat = z.strictObject({ id, title: z.string().max(4000), pinned: z.boolean(), archived: z.boolean(), ephemeral: z.boolean().optional(), documentScope: storedScope.optional(), summary: z.string().nullable().optional(), summaryUpToMessageId: z.string().nullable().optional(), summaryModelId: z.string().nullable().optional(), historyRevision: count.optional(), summaryRevision: count.nullable().optional(), lastMessageAt: date, ...timestamps, tags: z.array(z.strictObject({ chatId: id, label: z.string().min(1).max(40) })).max(8), messages: z.array(message).max(BACKUP_LIMITS.rows) });
// Provenance travels with the entry: restoring a memory the user never
// accepted must not turn it into one they are treated as having accepted.
const memory = z.strictObject({ id, key: z.string().max(2000), value: text, score: z.number().nullable(), source: z.enum(["manual", "assistant"]).optional(), confirmed: z.boolean().optional(), lastUsedAt: date.nullable().optional(), embedding: z.array(z.number()).max(16_384).nullable(), embeddingModelId: z.string().max(200).nullable().optional(), embeddingModelProvider: providerIdSchema.nullable().optional(), ...timestamps });
const task = z.strictObject({ id, title: z.string().max(4000), details: text.nullable(), dueDate: date.nullable(), timeZone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }), reminderEnabled: z.boolean(), remindedAt: date.nullable(), repeatRule: z.enum(["none", "daily", "weekly", "monthly"]), repeatAnchor: date.nullable(), repeatGenerated: z.boolean(), priority: z.enum(["low", "medium", "high"]), status: z.enum(["todo", "in_progress", "done"]), ...timestamps });
const chunk = z.strictObject({ id, documentId: id, chunkKey: z.string().max(200), ordinal: count, pageNumber: count.nullable(), text, heading: z.string().max(600).nullable().default(null), tokenCount: count.default(0), terms: z.array(z.strictObject({ chunkId: id, term: z.string().min(1).max(100), frequency: count.positive().default(1) })).max(3000) });
const document = z.strictObject({ id, filename: z.string().min(1).max(180), collection: z.string().max(40).nullable().optional(), format: z.enum(["pdf", "docx", "md", "txt"]), byteSize: count.max(8 * 1024 * 1024), contentHash: z.string().max(128), pages: documentPagesSchema, characterCount: count.max(100_000), indexVersion: count, indexedAt: date, ...timestamps, chunks: z.array(chunk).max(256) });
const asset = z.strictObject({ id: backupId, mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]), byteSize: count.positive().max(100 * 1024 * 1024), kind: z.enum(["attachment", "generated-image", "generated-video"]), modelId: z.string().max(200).nullable(), modelProvider: providerIdSchema.nullable().optional(), description: z.string().max(4000).nullable(), generation: generationRecipeSchema.nullable(), sourceChatId: id.nullable(), createdAt: date, lastUsedAt: date, sha256: z.string().regex(/^[a-f0-9]{64}$/), references: z.array(z.strictObject({ messageId: id, assetId: backupId })).max(BACKUP_LIMITS.rows), inputs: z.array(z.strictObject({ assetId: backupId, inputAssetId: backupId })).max(4) });
const usage = z.strictObject({ id, requestId: id, mode: z.enum(["chat", "image", "video", "embedding"]), modelId: z.string().max(200), modelProvider: providerIdSchema.optional(), source: z.enum(["chat", "summary", "scheduled", "tool", "embedding", "media", "unattributed"]).optional(), estimatedUsd: z.number().nonnegative().nullable().optional(), status: z.enum(["success", "error", "aborted", "pending", "interrupted"]), durationMs: count, inputTokens: count.nullable(), outputTokens: count.nullable(), costUsd: z.number().nonnegative().nullable(), costSource: z.enum(["provider", "configured", "unknown"]), errorCode: z.string().max(60).nullable(), fallback: z.boolean(), createdAt: date });
export const backupManifestSchema = z.strictObject({
  format: z.literal("private-ai-account-backup"), version: z.literal(1), createdAt: date,
  chats: z.array(chat).max(BACKUP_LIMITS.rows), memories: z.array(memory).max(BACKUP_LIMITS.rows), tasks: z.array(task).max(BACKUP_LIMITS.rows), documents: z.array(document).max(100), assets: z.array(asset).max(BACKUP_LIMITS.rows), // Every shape the library has had, so an archive written before provider
  // qualified references still imports. Conversion happens on read; the archive
  // itself is never rewritten.
  preferences: z.union([preferencesSchema, providerAgnosticPreferencesSchema, legacyPreferencesSchema]), usage: z.array(usage).max(5000),
  events: z.array(eventSchema).max(10_000).default([]),
  activityCoverage: z.strictObject({ recordingStartedAt: date, completeSince: date }).nullable().default(null),
  reviews: z.array(z.strictObject({ id, period: z.enum(["daily", "weekly"]), timeZone: task.shape.timeZone,
    startAt: date, endAt: date, facts: factsSchema, chatId: id.nullable(), modelStatus: z.enum(["disabled", "empty", "pending", "succeeded", "failed", "interrupted"]),
    modelError: z.string().max(60).nullable(), modelText: z.string().max(100_000).nullable(), createdAt: date,
  })).max(1000).default([]),
}).superRefine((data, context) => {
  const error = () => context.addIssue({ code: "custom", message: "Backup contains duplicate, inconsistent or excessive relationships" });
  const messages = data.chats.flatMap(chat => chat.messages);
  const chunks = data.documents.flatMap(document => document.chunks);
  if (messages.length > BACKUP_LIMITS.rows || chunks.flatMap(chunk => chunk.terms).length > 100_000) error();
  const unique = (rows: { id: string }[]) => { const ids = new Set(rows.map(row => row.id)); if (ids.size !== rows.length) error(); return ids; };
  const distinct = (values: string[]) => { if (new Set(values).size !== values.length) error(); };
  const chats = unique(data.chats), messageIds = unique(messages), assetIds = unique(data.assets);
  unique(data.memories); unique(data.tasks); unique(data.documents); unique(chunks); unique(data.usage);
  unique([...data.chats, ...messages, ...data.memories, ...data.tasks, ...data.documents, ...chunks, ...data.assets, ...data.usage, ...data.events, ...data.reviews]);
  if (data.events.length && !data.activityCoverage) error();
  if (data.activityCoverage && Date.parse(data.activityCoverage.completeSince) < Date.parse(data.activityCoverage.recordingStartedAt)) error();
  distinct(data.reviews.map(review => `${review.period}:${review.timeZone}:${review.startAt}`));
  distinct(data.reviews.flatMap(review => review.chatId ? [review.chatId] : []));
  for (const review of data.reviews) if (Date.parse(review.startAt) > Date.parse(review.endAt) || review.chatId && !chats.has(review.chatId)) error();
  distinct(data.memories.map(row => row.key)); distinct(data.documents.map(row => row.filename));
  for (const chat of data.chats) {
    if (chat.messages.some(message => message.chatId !== chat.id) || chat.tags.some(tag => tag.chatId !== chat.id)) error();
    distinct(chat.tags.map(tag => tag.label));
  }
  for (const document of data.documents) {
    if (document.chunks.some(chunk => chunk.documentId !== document.id || chunk.terms.some(term => term.chunkId !== chunk.id))) error();
    distinct(document.chunks.map(chunk => chunk.chunkKey));
    for (const chunk of document.chunks) distinct(chunk.terms.map(term => term.term));
  }
  const inputs = new Map(data.assets.map(asset => [asset.id, asset.inputs.length]));
  const dependents = new Map<string, string[]>();
  for (const asset of data.assets) {
    if (asset.sourceChatId && !chats.has(asset.sourceChatId)) error();
    if (asset.references.some(ref => ref.assetId !== asset.id || !messageIds.has(ref.messageId)) || asset.inputs.some(ref => ref.assetId !== asset.id || ref.inputAssetId === asset.id || !assetIds.has(ref.inputAssetId))) error();
    const recorded = new Set(asset.generation?.inputImages.map(input => input.assetId) ?? []);
    if (recorded.size !== asset.inputs.length || asset.inputs.some(ref => !recorded.has(ref.inputAssetId))) error();
    distinct(asset.references.map(ref => ref.messageId)); distinct(asset.inputs.map(ref => ref.inputAssetId));
    for (const input of asset.inputs) { const list = dependents.get(input.inputAssetId) ?? []; list.push(asset.id); dependents.set(input.inputAssetId, list); }
  }
  // Topological traversal rejects cyclic media references without recursion.
  const ready = data.assets.filter(asset => !asset.inputs.length).map(asset => asset.id);
  for (let i = 0; i < ready.length; i++) for (const id of dependents.get(ready[i]) ?? []) {
    const remaining = (inputs.get(id) ?? 0) - 1; inputs.set(id, remaining); if (!remaining) ready.push(id);
  }
  if (ready.length !== data.assets.length) error();
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;
