import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/db";
import { stageMediaFile } from "@/lib/media/storage";
import { ASSISTANT_TOOL_MESSAGE_PREFIX } from "@/lib/ai/ui-message";
import { openBackup } from "@/lib/backups/files";
import { createAccountBackup, pruneAccountBackupsSafely, readBackupAsset, readBackupManifest } from "@/lib/backups/archive";

export async function restoreAccountBackup(userId: string, id: string) {
  const archive = await openBackup(userId, id);
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
      const file = await stageMediaFile({ userId, bytes: await readBackupAsset(archive, asset, offset), kind: asset.kind, mediaType: asset.mediaType });
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
          for (const tool of payload.tools) if (!["output-available", "output-error", "output-denied"].includes(tool.state)) { tool.state = "output-denied"; tool.errorText = "恢复的历史审批不会重新执行。"; }
        }
        return prefix + JSON.stringify(transform(payload));
      } catch { return text; }
    }
    const safety = await createAccountBackup(userId, false);
    await db.$transaction(async tx => {
      await tx.chat.deleteMany({ where: { userId } });
      await tx.mediaAsset.deleteMany({ where: { userId } });
      await tx.memory.deleteMany({ where: { userId } });
      await tx.task.deleteMany({ where: { userId } });
      await tx.knowledgeDocument.deleteMany({ where: { userId } });
      await tx.modelRequest.deleteMany({ where: { userId } });
      for (let i = 0; i < manifest.chats.length; i += 250) await tx.chat.createMany({ data: manifest.chats.slice(i, i + 250).map(({ messages: _messages, tags: _tags, ...chat }) => ({ ...chat, id: mapped(chat.id), userId })) });
      const tags = manifest.chats.flatMap(chat => chat.tags.map(tag => ({ ...tag, chatId: mapped(tag.chatId) })));
      for (let i = 0; i < tags.length; i += 500) await tx.chatTag.createMany({ data: tags.slice(i, i + 500) });
      const messages = manifest.chats.flatMap(chat => chat.messages.map(message => ({ ...message, id: mapped(message.id), chatId: mapped(message.chatId), clientMessageId: null, content: content(message.content), status: message.status === "pending" ? "error" as const : message.status })));
      for (let i = 0; i < messages.length; i += 250) await tx.message.createMany({ data: messages.slice(i, i + 250) });
      const assets = manifest.assets.map((asset, index) => ({ ...staged[index], userId, modelId: asset.modelId, description: asset.description, generation: asset.generation ? JSON.parse(JSON.stringify(transform(asset.generation))) as Prisma.InputJsonValue : Prisma.DbNull, sourceChatId: asset.sourceChatId ? mapped(asset.sourceChatId) : null, createdAt: asset.createdAt, lastUsedAt: new Date() }));
      for (let i = 0; i < assets.length; i += 250) await tx.mediaAsset.createMany({ data: assets.slice(i, i + 250) });
      const references = manifest.assets.flatMap(asset => asset.references.map(ref => ({ messageId: mapped(ref.messageId), assetId: mapped(ref.assetId) })));
      for (let i = 0; i < references.length; i += 500) await tx.messageMedia.createMany({ data: references.slice(i, i + 500) });
      const inputs = manifest.assets.flatMap(asset => asset.inputs.map(ref => ({ assetId: mapped(ref.assetId), inputAssetId: mapped(ref.inputAssetId) })));
      for (let i = 0; i < inputs.length; i += 500) await tx.mediaGenerationInput.createMany({ data: inputs.slice(i, i + 500) });
      for (let i = 0; i < manifest.memories.length; i += 250) await tx.memory.createMany({ data: manifest.memories.slice(i, i + 250).map(memory => ({ ...memory, id: mapped(memory.id), userId, embedding: memory.embedding ?? Prisma.DbNull })) });
      for (let i = 0; i < manifest.tasks.length; i += 250) await tx.task.createMany({ data: manifest.tasks.slice(i, i + 250).map(task => ({ ...task, id: mapped(task.id), userId, reminderEnabled: false })) });
      await tx.knowledgeDocument.createMany({ data: manifest.documents.map(({ chunks: _chunks, ...document }) => ({ ...document, id: mapped(document.id), userId })) });
      const chunks = manifest.documents.flatMap(document => document.chunks.map(({ terms: _terms, ...chunk }) => ({ ...chunk, id: mapped(chunk.id), documentId: mapped(chunk.documentId) })));
      for (let i = 0; i < chunks.length; i += 250) await tx.documentChunk.createMany({ data: chunks.slice(i, i + 250) });
      const terms = manifest.documents.flatMap(document => document.chunks.flatMap(chunk => chunk.terms.map(term => ({ ...term, chunkId: mapped(term.chunkId) }))));
      for (let i = 0; i < terms.length; i += 500) await tx.documentTerm.createMany({ data: terms.slice(i, i + 500) });
      for (let i = 0; i < manifest.usage.length; i += 250) await tx.modelRequest.createMany({ data: manifest.usage.slice(i, i + 250).map(row => ({ ...row, id: mapped(row.id), userId })) });
      await tx.accountPreference.upsert({ where: { userId }, create: { userId, settings: manifest.preferences }, update: { settings: manifest.preferences } });
    });
    const cleanup = await pruneAccountBackupsSafely(userId, safety.id);
    return { safetyBackupId: safety.id, restored: true, cleanupFailed: !!cleanup.failed };
  } finally { await archive.close(); }
}
