import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { pruneTerminalLogs } from "@/lib/terminal/logs";
import { activeTerminalSessionIds } from "@/lib/terminal/runtime";
import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { stageMediaFile } from "@/lib/media/storage";
import { ASSISTANT_TOOL_MESSAGE_PREFIX } from "@/lib/ai/ui-message";
import { openBackup } from "@/lib/backups/files";
import { createAccountBackup, pruneAccountBackupsSafely, readBackupAsset, readBackupManifest, verifyBackupBlock } from "@/lib/backups/archive";
import { unpackDocumentContent } from "@/lib/backups/documents";
import { hasDocumentContent } from "@/lib/backups/schema";
import { hashDocumentContent } from "@/lib/documents/chunks";
import { documentEmbeddingText, documentSearchText, documentTerms } from "@/lib/documents/lexical";
import { decodeDocumentVector } from "@/lib/documents/vectors";
import { PREFERENCE_ROW_ID, withModelSettingsLock } from "@/lib/models/preferences";
import { upgradeModelPreferences } from "@/lib/models/preferences-schema";
import { isDefaultAssistantId } from "@/lib/assistants/schema";
import { defaultApprovalRule } from "@/lib/approvals/preferences";
import { resultConversations } from "@/lib/backups/legacy-topics";
import { announceConversationsChanged } from "@/lib/conversations/events";

export async function restoreAccountBackup(id: string) {
  const archive = await openBackup(id);
  try {
    const { manifest, offset: start } = await readBackupManifest(archive);
    const ids = new Map<string, string>();
    const rows = [...manifest.assistantTemplates, ...manifest.chats, ...manifest.chats.flatMap(chat => chat.messages), ...manifest.memories, ...manifest.tasks, ...manifest.documents, ...manifest.documents.flatMap(document => "chunks" in document ? document.chunks : []), ...manifest.usage];
    for (const row of rows) ids.set(row.id, randomUUID());
    // The default templates keep their ids: the templates are replaced as a
    // whole, so they cannot collide, and the id is what marks them as defaults.
    for (const template of manifest.assistantTemplates) if (isDefaultAssistantId(template.id)) ids.set(template.id, template.id);
    const templateIds = new Map(manifest.assistantTemplates.map(template => [template.id, ids.get(template.id)!]));
    const staged: Awaited<ReturnType<typeof stageMediaFile>>[] = [];
    let offset = start;
    // Validate every file before changing business rows. New immutable files do
    // not replace existing paths, so a rollback leaves the live data usable.
    for (const asset of manifest.assets) {
      const file = await stageMediaFile({ bytes: await readBackupAsset(archive, asset, offset), kind: asset.kind, mediaType: asset.mediaType });
      ids.set(asset.id, file.id); staged.push(file); offset += asset.byteSize;
    }
    // Each document's block is checked before anything is replaced; it is unpacked one at a time later.
    const documentOffsets: number[] = [];
    for (const document of manifest.documents) {
      if (!hasDocumentContent(document)) { documentOffsets.push(-1); continue; }
      await verifyBackupBlock(archive, document.content, offset);
      documentOffsets.push(offset); offset += document.content.byteSize;
    }
    const mapped = (id: string) => ids.get(id) ?? id;
    const documentLinks = (text: string) => text.replace(/(?<![a-zA-Z0-9:/])\/knowledge\/documents\/([a-zA-Z0-9_-]+)(\?version=[a-f0-9]{64})?(?:#([a-zA-Z0-9_-]+))?/g,
      (_link, documentId: string, version: string | undefined, chunkId: string | undefined) => `/knowledge/documents/${mapped(documentId)}${version ?? ""}${chunkId ? `#${mapped(chunkId)}` : ""}`);
    function transform(value: unknown, field = ""): unknown {
      if (typeof value === "string") {
        if (field === "snippet") return value;
        // A picture made in chat names its file (mediaId) and the pictures it was built on (referenceImages).
        if (["id", "assistantTemplateId", "templateId", "assetId", "inputAssetId", "chatId", "sourceChatId", "messageId", "documentId", "chunkId", "mediaId", "referenceImages"].includes(field)) return mapped(value);
        if (["url", "videoUrl"].includes(field)) return documentLinks(value.replace(/^\/api\/media\/([a-f0-9-]{36})$/, (_match, id) => `/api/media/${mapped(id)}`));
        return documentLinks(value);
      }
      if (Array.isArray(value)) return value.map(child => transform(child, field));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "relativePath" && key !== "approval").map(([key, child]) => [key, transform(child, key)]));
      return value;
    }
    function content(text: string) {
      const prefix = /^__(?:USER_MESSAGE|ASSISTANT_TOOL_MESSAGE|IMAGE_RESULT|VIDEO_RESULT)__:/.exec(text)?.[0];
      if (!prefix) return documentLinks(text);
      try {
        const payload = JSON.parse(text.slice(prefix.length));
        if (prefix === ASSISTANT_TOOL_MESSAGE_PREFIX && Array.isArray(payload.tools)) {
          for (const tool of payload.tools) if (!["output-available", "output-error", "output-denied"].includes(tool.state)) { tool.state = "output-denied"; tool.errorText = t("lib.backups.approvalNotReplayed"); }
        }
        return prefix + JSON.stringify(transform(payload));
      } catch { return text; }
    }
    const restoredPreferences = upgradeModelPreferences(manifest.preferences);
    // An archive from while knowledge topics existed: each finished result
    // comes back as a conversation of its own.
    const results = resultConversations(manifest.topics, manifest.artifacts, await defaultApprovalRule(), documentLinks);
    const { safety, paused } = await withModelSettingsLock(async () => {
      const safety = await createAccountBackup(false);
      // A restore replaces the whole workspace while nothing else may change it, and a large
      // knowledge base takes minutes to write back, so it is given that long.
      const paused = await db.$transaction(async tx => {
      // A restore replaces the workspace: conversations go first so their
      // messages, tags and asset references cascade away with them.
      await tx.chat.deleteMany({});
      await tx.assistantTemplate.deleteMany({});
      await tx.assistantTemplate.createMany({ data: manifest.assistantTemplates.map(template => ({ ...template, id: mapped(template.id) })) });
      await tx.workspaceReview.deleteMany({});
      await tx.workspaceEvent.deleteMany({});
      await tx.mediaAsset.deleteMany({});
      await tx.memory.deleteMany({});
      await tx.memoryDocument.deleteMany({});
      if (manifest.memoryDocument) await tx.memoryDocument.create({ data: manifest.memoryDocument });
      await tx.knowledgeDocument.deleteMany({});
      await tx.modelRequest.deleteMany({});
      // `summaryUpToMessageId` names a message in this very chat, and every
      // message gets a new id on the way in. Left alone it would be a pointer
      // to a row that no longer exists: the coverage note would offer an id the
      // reader could never find, and the next summary would treat the restored
      // one as covering nothing.
      // A conversation's link to a topic and its topic scope are from an older archive and are dropped.
      const chats = manifest.chats.map(({ messages, tags: _tags, topicId: _topicId, documentScope: _scope, ...chat }) => {
        const validSummary = chat.summary && chat.summaryRevision != null && chat.summaryRevision === (chat.historyRevision ?? 0)
          && (!chat.summaryUpToMessageId ? Boolean(chat.summaryState) : messages.some(message => message.id === chat.summaryUpToMessageId));
        return { ...chat, assistantConfig: chat.assistantConfig ? { ...chat.assistantConfig, templateId: templateIds.get(chat.assistantConfig.templateId) ?? chat.assistantConfig.templateId } : Prisma.DbNull, id: mapped(chat.id), historyRevision: chat.historyRevision ?? 0,
          summary: validSummary ? chat.summary : null, summaryRevision: validSummary ? chat.summaryRevision : null,
          summaryModelId: validSummary ? chat.summaryModelId : null,
          summaryState: validSummary ? chat.summaryState : null,
          summaryUpToMessageId: validSummary && chat.summaryUpToMessageId ? mapped(chat.summaryUpToMessageId) : null,
        };
      });
      for (let i = 0; i < chats.length; i += 250) await tx.chat.createMany({ data: chats.slice(i, i + 250) });
      if (results.length) {
        await tx.chat.createMany({ data: results.map(result => result.chat) });
        await tx.message.createMany({ data: results.flatMap(result => result.messages) });
      }
      const tags = manifest.chats.flatMap(chat => chat.tags.map(tag => ({ ...tag, chatId: mapped(tag.chatId) })));
      for (let i = 0; i < tags.length; i += 500) await tx.chatTag.createMany({ data: tags.slice(i, i + 500) });
      const messages = manifest.chats.flatMap(chat => chat.messages.map(message => ({ ...message, id: mapped(message.id), chatId: mapped(message.chatId), clientMessageId: null, content: content(message.content), status: message.status === "pending" ? "error" as const : message.status })));
      for (let i = 0; i < messages.length; i += 250) await tx.message.createMany({ data: messages.slice(i, i + 250) });
      const assets = manifest.assets.map((asset, index) => ({ ...staged[index], contentHash: /^[a-f0-9]{64}$/.test(asset.sha256) ? asset.sha256 : null, modelId: asset.modelId, modelProvider: asset.modelProvider ?? null, description: asset.description, generation: asset.generation ? JSON.parse(JSON.stringify(transform(asset.generation))) as Prisma.InputJsonValue : Prisma.DbNull, sourceChatId: asset.sourceChatId ? mapped(asset.sourceChatId) : null, createdAt: asset.createdAt, lastUsedAt: asset.lastUsedAt }));
      for (let i = 0; i < assets.length; i += 250) await tx.mediaAsset.createMany({ data: assets.slice(i, i + 250) });
      const references = manifest.assets.flatMap(asset => asset.references.map(ref => ({ messageId: mapped(ref.messageId), assetId: mapped(ref.assetId) })));
      for (let i = 0; i < references.length; i += 500) await tx.messageMedia.createMany({ data: references.slice(i, i + 500) });
      const inputs = manifest.assets.flatMap(asset => asset.inputs.map(ref => ({ assetId: mapped(ref.assetId), inputAssetId: mapped(ref.inputAssetId) })));
      for (let i = 0; i < inputs.length; i += 500) await tx.mediaGenerationInput.createMany({ data: inputs.slice(i, i + 500) });
      for (let i = 0; i < manifest.memories.length; i += 250) await tx.memory.createMany({ data: manifest.memories.slice(i, i + 250).map(memory => ({ ...memory, id: mapped(memory.id), embedding: memory.embedding ?? Prisma.DbNull, embeddingModelId: memory.embeddingModelId ?? null, embeddingModelProvider: memory.embeddingModelProvider ?? null, source: memory.source ?? "manual", confirmed: memory.confirmed ?? true, lastUsedAt: memory.lastUsedAt ?? null })) });
      // To-dos from an older archive are not brought back: the workspace no longer has them.
      for (const [index, document] of manifest.documents.entries()) {
        const documentId = mapped(document.id);
        const context = { filename: document.filename, collection: document.collection ?? null };
        let chunks: Array<{ id: string; chunkKey: string; ordinal: number; pageNumber?: number | null; text: string; heading?: string | null; tokenCount: number; vector: { providerId: string; modelId: string; contextHash: string; bytes: Uint8Array } | null }>;
        if (hasDocumentContent(document)) {
          let content: Awaited<ReturnType<typeof unpackDocumentContent>>;
          try { content = await unpackDocumentContent(await readBackupAsset(archive, document.content, documentOffsets[index])); }
          catch { throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.backups.invalidArchive") }); }
          const { content: _content, chunkCount: _count, ...fields } = document;
          await tx.knowledgeDocument.create({ data: { ...fields, collection: context.collection, id: documentId, pages: content.pages } });
          chunks = content.chunks.map(({ vector, ...chunk }) => ({ ...chunk, vector: vector ? { ...vector, bytes: content.vectors.subarray(vector.offset, vector.offset + vector.length) } : null }));
        } else {
          // An archive from before format 2: no vectors, and its keyword terms are rebuilt from the text.
          const { chunks: archived, ...fields } = document;
          await tx.knowledgeDocument.create({ data: { ...fields, collection: context.collection, id: documentId } });
          chunks = archived.map(({ terms: _terms, documentId: _document, ...chunk }) => ({ ...chunk, id: mapped(chunk.id), vector: null }));
        }
        const rows = chunks.map(({ vector, ...chunk }) => {
          // A vector comes back only when it still describes its chunk as written now.
          const current = vector && decodeDocumentVector(vector.bytes) && vector.contextHash === hashDocumentContent(documentEmbeddingText(chunk, context));
          return { ...chunk, documentId, ...(current ? { vector: Buffer.from(vector.bytes), embeddingModelProvider: vector.providerId, embeddingModelId: vector.modelId, embeddingContextHash: vector.contextHash } : {}) };
        });
        for (let i = 0; i < rows.length; i += 250) await tx.documentChunk.createMany({ data: rows.slice(i, i + 250) });
        const search = chunks.map(chunk => ({ chunkId: chunk.id, terms: documentSearchText(documentTerms(documentEmbeddingText(chunk, context)).terms) }));
        for (let i = 0; i < search.length; i += 500) await tx.documentChunkSearch.createMany({ data: search.slice(i, i + 500) });
      }
      for (let i = 0; i < manifest.usage.length; i += 250) await tx.modelRequest.createMany({ data: manifest.usage.slice(i, i + 250).map(row => ({ ...row, ...(row.status === "pending" ? { status: "interrupted", errorCode: "PROCESS_INTERRUPTED", costUsd: null, costSource: "unknown" } : {}), id: mapped(row.id) })) });
      for (let i = 0; i < manifest.events.length; i += 250) await tx.workspaceEvent.createMany({ data: manifest.events.slice(i, i + 250).map(event => ({ ...event, entityId: mapped(event.entityId) })) });
      const coverage = manifest.activityCoverage ?? { recordingStartedAt: new Date().toISOString(), completeSince: new Date().toISOString() };
      await tx.workspaceActivityState.upsert({ where: { id: "local" }, create: { id: "local", ...coverage }, update: coverage });
      for (let i = 0; i < manifest.reviews.length; i += 250) await tx.workspaceReview.createMany({ data: manifest.reviews.slice(i, i + 250).map(review => ({
        ...review, chatId: review.chatId ? mapped(review.chatId) : null,
        modelStatus: review.modelStatus === "pending" ? "interrupted" : review.modelStatus,
        modelError: review.modelStatus === "pending" ? "INTERRUPTED" : review.modelError,
        facts: { ...review.facts, sources: review.facts.sources.map(event => ({ ...event, entityId: mapped(event.entityId) })) },
      })) });
      await tx.workspacePreference.upsert({ where: { id: PREFERENCE_ROW_ID }, create: { id: PREFERENCE_ROW_ID, settings: restoredPreferences as Prisma.InputJsonValue }, update: { settings: restoredPreferences as Prisma.InputJsonValue } });
      /*
       * Schedules and the folders the user granted are permissions on a
       * machine, not workspace content, and a restore is a moment where the
       * user is least likely to be watching. Both are therefore switched off
       * by a restore, and the counts are reported so the interface can say what
       * was paused rather than leaving the user to find out later that nothing
       * ran.
       *
       * They are switched off here, in the same transaction as the rows they
       * would outlive, rather than after it. A restore that committed and then
       * failed to pause left a replaced workspace that could still run things
       * the interface had never reported pausing, and reported the whole
       * restore as a failure.
       */
      const pausedSchedules = await tx.scheduledJob.updateMany({ where: { enabled: true }, data: { enabled: false } });
      // Withdrawn grants are not kept as history; records an earlier version kept go too.
      const revokedGrants = await tx.directoryGrant.deleteMany({ where: { revokedAt: null } });
      await tx.directoryGrant.deleteMany({});
      // Machine-local extensions are not imported. Restoring a workspace must
      // not leave its previous external capabilities active for restored chats.
      await tx.extension.updateMany({ data: { enabled: false, revision: { increment: 1 }, testedRevision: null, testId: null } });
      await tx.pluginPackage.updateMany({ data: { enabled: false, revision: { increment: 1 } } });
      return { pausedSchedules: pausedSchedules.count, revokedDirectoryGrants: revokedGrants.count };
      }, { timeout: 30 * 60_000 });
      return { safety, paused };
    });
    const cleanup = await pruneAccountBackupsSafely(safety.id);
    // Restored runs replace the previous ones; their terminal logs go with them.
    await pruneTerminalLogs(activeTerminalSessionIds()).catch(() => console.error("terminal.log.prune.failed"));
    announceConversationsChanged();
    return {
      safetyBackupId: safety.id,
      restored: true,
      cleanupFailed: !!cleanup.failed,
      pausedSchedules: paused.pausedSchedules,
      revokedDirectoryGrants: paused.revokedDirectoryGrants
    };
  } finally { await archive.close(); }
}
