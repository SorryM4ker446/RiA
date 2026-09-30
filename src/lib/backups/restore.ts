import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { stageMediaFile } from "@/lib/media/storage";
import { ASSISTANT_TOOL_MESSAGE_PREFIX } from "@/lib/ai/ui-message";
import { openBackup } from "@/lib/backups/files";
import { createAccountBackup, pruneAccountBackupsSafely, readBackupAsset, readBackupManifest } from "@/lib/backups/archive";
import { PREFERENCE_ROW_ID, withModelSettingsLock } from "@/lib/models/preferences";
import { upgradeModelPreferences } from "@/lib/models/preferences-schema";

export async function restoreAccountBackup(id: string) {
  const archive = await openBackup(id);
  try {
    const { manifest, offset: start } = await readBackupManifest(archive);
    const ids = new Map<string, string>();
    const rows = [...manifest.chats, ...manifest.chats.flatMap(chat => chat.messages), ...manifest.memories, ...manifest.tasks, ...manifest.documents, ...manifest.documents.flatMap(document => document.chunks), ...manifest.usage];
    for (const row of rows) ids.set(row.id, randomUUID());
    const staged: Awaited<ReturnType<typeof stageMediaFile>>[] = [];
    let offset = start;
    // Validate every file before changing business rows. New immutable files do
    // not replace existing paths, so a rollback leaves the live data usable.
    for (const asset of manifest.assets) {
      const file = await stageMediaFile({ bytes: await readBackupAsset(archive, asset, offset), kind: asset.kind, mediaType: asset.mediaType });
      ids.set(asset.id, file.id); staged.push(file); offset += asset.byteSize;
    }
    const mapped = (id: string) => ids.get(id) ?? id;
    function transform(value: unknown, field = ""): unknown {
      if (typeof value === "string") {
        if (["id", "assetId", "inputAssetId", "chatId", "sourceChatId", "messageId", "documentId", "chunkId"].includes(field)) return mapped(value);
        if (["url", "videoUrl"].includes(field)) return value.replace(/^\/api\/media\/([a-f0-9-]{36})$/, (_match, id) => `/api/media/${mapped(id)}`);
        return value;
      }
      if (Array.isArray(value)) return value.map(child => transform(child, field));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "relativePath" && key !== "approval").map(([key, child]) => [key, transform(child, key)]));
      return value;
    }
    function content(text: string) {
      const prefix = /^__(?:USER_MESSAGE|ASSISTANT_TOOL_MESSAGE|IMAGE_RESULT|VIDEO_RESULT)__:/.exec(text)?.[0];
      if (!prefix) return text;
      try {
        const payload = JSON.parse(text.slice(prefix.length));
        if (prefix === ASSISTANT_TOOL_MESSAGE_PREFIX && Array.isArray(payload.tools)) {
          for (const tool of payload.tools) if (!["output-available", "output-error", "output-denied"].includes(tool.state)) { tool.state = "output-denied"; tool.errorText = t("lib.backups.approvalNotReplayed"); }
        }
        return prefix + JSON.stringify(transform(payload));
      } catch { return text; }
    }
    const restoredPreferences = upgradeModelPreferences(manifest.preferences);
    const { safety, paused } = await withModelSettingsLock(async () => {
      const safety = await createAccountBackup(false);
      const paused = await db.$transaction(async tx => {
      // A restore replaces the workspace: conversations go first so their
      // messages, tags and asset references cascade away with them.
      await tx.chat.deleteMany({});
      await tx.mediaAsset.deleteMany({});
      await tx.memory.deleteMany({});
      await tx.task.deleteMany({});
      await tx.knowledgeDocument.deleteMany({});
      await tx.modelRequest.deleteMany({});
      // `summaryUpToMessageId` names a message in this very chat, and every
      // message gets a new id on the way in. Left alone it would be a pointer
      // to a row that no longer exists: the coverage note would offer an id the
      // reader could never find, and the next summary would treat the restored
      // one as covering nothing.
      const chats = manifest.chats.map(({ messages: _messages, tags: _tags, ...chat }) => ({ ...chat, id: mapped(chat.id), summaryUpToMessageId: chat.summaryUpToMessageId && ids.has(chat.summaryUpToMessageId) ? mapped(chat.summaryUpToMessageId) : null }));
      for (let i = 0; i < chats.length; i += 250) await tx.chat.createMany({ data: chats.slice(i, i + 250) });
      const tags = manifest.chats.flatMap(chat => chat.tags.map(tag => ({ ...tag, chatId: mapped(tag.chatId) })));
      for (let i = 0; i < tags.length; i += 500) await tx.chatTag.createMany({ data: tags.slice(i, i + 500) });
      const messages = manifest.chats.flatMap(chat => chat.messages.map(message => ({ ...message, id: mapped(message.id), chatId: mapped(message.chatId), clientMessageId: null, content: content(message.content), status: message.status === "pending" ? "error" as const : message.status })));
      for (let i = 0; i < messages.length; i += 250) await tx.message.createMany({ data: messages.slice(i, i + 250) });
      const assets = manifest.assets.map((asset, index) => ({ ...staged[index], modelId: asset.modelId, modelProvider: asset.modelProvider ?? null, description: asset.description, generation: asset.generation ? JSON.parse(JSON.stringify(transform(asset.generation))) as Prisma.InputJsonValue : Prisma.DbNull, sourceChatId: asset.sourceChatId ? mapped(asset.sourceChatId) : null, createdAt: asset.createdAt, lastUsedAt: asset.lastUsedAt }));
      for (let i = 0; i < assets.length; i += 250) await tx.mediaAsset.createMany({ data: assets.slice(i, i + 250) });
      const references = manifest.assets.flatMap(asset => asset.references.map(ref => ({ messageId: mapped(ref.messageId), assetId: mapped(ref.assetId) })));
      for (let i = 0; i < references.length; i += 500) await tx.messageMedia.createMany({ data: references.slice(i, i + 500) });
      const inputs = manifest.assets.flatMap(asset => asset.inputs.map(ref => ({ assetId: mapped(ref.assetId), inputAssetId: mapped(ref.inputAssetId) })));
      for (let i = 0; i < inputs.length; i += 500) await tx.mediaGenerationInput.createMany({ data: inputs.slice(i, i + 500) });
      for (let i = 0; i < manifest.memories.length; i += 250) await tx.memory.createMany({ data: manifest.memories.slice(i, i + 250).map(memory => ({ ...memory, id: mapped(memory.id), embedding: memory.embedding ?? Prisma.DbNull, embeddingModelId: memory.embeddingModelId ?? null, embeddingModelProvider: memory.embeddingModelProvider ?? null, source: memory.source ?? "manual", confirmed: memory.confirmed ?? true, lastUsedAt: memory.lastUsedAt ?? null })) });
      for (let i = 0; i < manifest.tasks.length; i += 250) await tx.task.createMany({ data: manifest.tasks.slice(i, i + 250).map(task => ({ ...task, id: mapped(task.id), reminderEnabled: false })) });
      await tx.knowledgeDocument.createMany({ data: manifest.documents.map(({ chunks: _chunks, ...document }) => ({ ...document, id: mapped(document.id) })) });
      const chunks = manifest.documents.flatMap(document => document.chunks.map(({ terms: _terms, ...chunk }) => ({ ...chunk, id: mapped(chunk.id), documentId: mapped(chunk.documentId) })));
      for (let i = 0; i < chunks.length; i += 250) await tx.documentChunk.createMany({ data: chunks.slice(i, i + 250) });
      const terms = manifest.documents.flatMap(document => document.chunks.flatMap(chunk => chunk.terms.map(term => ({ ...term, chunkId: mapped(term.chunkId) }))));
      for (let i = 0; i < terms.length; i += 500) await tx.documentTerm.createMany({ data: terms.slice(i, i + 500) });
      for (let i = 0; i < manifest.usage.length; i += 250) await tx.modelRequest.createMany({ data: manifest.usage.slice(i, i + 250).map(row => ({ ...row, id: mapped(row.id) })) });
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
      const revokedAt = new Date();
      const pausedSchedules = await tx.scheduledJob.updateMany({ where: { enabled: true }, data: { enabled: false } });
      const revokedGrants = await tx.directoryGrant.updateMany({ where: { revokedAt: null }, data: { revokedAt } });
      return { pausedSchedules: pausedSchedules.count, revokedDirectoryGrants: revokedGrants.count };
      });
      return { safety, paused };
    });
    const cleanup = await pruneAccountBackupsSafely(safety.id);
    return {
      safetyBackupId: safety.id,
      restored: true,
      cleanupFailed: !!cleanup.failed,
      pausedSchedules: paused.pausedSchedules,
      revokedDirectoryGrants: paused.revokedDirectoryGrants
    };
  } finally { await archive.close(); }
}
