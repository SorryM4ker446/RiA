import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient();
const marker = randomUUID();
const preferenceId = "local";

try {
  // Business rows belong to the single workspace: no owner column is involved.
  const chat = await db.chat.create({
    data: {
      title: `Chat ${marker}`,
      pinned: true,
      archived: true,
      tags: { create: { label: "database-check" } },
      messages: {
        create: {
          clientMessageId: marker,
          role: "user",
          content: "Local database verification",
        },
      },
    },
    include: { messages: true, tags: true },
  });

  const memory = await db.memory.create({
    data: { key: `memory-${marker}`, value: "Local memory", score: 0.9, embedding: [0.1, 0.2, 0.3] },
  });

  const task = await db.task.create({
    data: {
      title: `Task ${marker}`,
      priority: "high",
      dueDate: new Date("2026-09-01T00:00:00Z"),
      timeZone: "Asia/Shanghai",
      reminderEnabled: true,
      repeatRule: "daily",
    },
  });

  if (
    chat.messages.length !== 1 ||
    chat.tags.length !== 1 ||
    !chat.pinned ||
    !chat.archived ||
    memory.embedding === null ||
    task.timeZone !== "Asia/Shanghai" ||
    task.reminderEnabled !== true ||
    task.repeatRule !== "daily" ||
    task.remindedAt !== null ||
    task.repeatGenerated !== false
  ) {
    throw new Error("Local database relations were not persisted as expected.");
  }

  const asset = await db.mediaAsset.create({
    data: {
      id: marker,
      relativePath: `database-check/${marker}.png`,
      mediaType: "image/png",
      byteSize: 1,
      kind: "attachment",
      references: { create: { messageId: chat.messages[0].id } },
    },
    include: { references: true },
  });
  if (asset.references.length !== 1) throw new Error("Media references were not persisted.");

  const generated = await db.mediaAsset.create({
    data: {
      id: randomUUID(),
      relativePath: `database-check/${marker}-generated.png`,
      mediaType: "image/png",
      byteSize: 1,
      kind: "generated-image",
      sourceChatId: chat.id,
      generation: { version: 1, type: "image", modelId: "offline/model", prompt: "Database check", inputImages: [{ assetId: asset.id, mediaType: "image/png" }] },
      inputs: { create: { inputAssetId: asset.id } },
    },
    include: { inputs: true, sourceChat: true },
  });
  if (generated.inputs.length !== 1 || generated.sourceChat.id !== chat.id) throw new Error("Media generation provenance was not persisted.");

  const document = await db.knowledgeDocument.create({
    data: {
      filename: `database-check-${marker}.txt`,
      format: "txt",
      byteSize: 5,
      contentHash: marker,
      pages: [{ pageNumber: null, text: "Local document" }],
      characterCount: 14,
      indexVersion: 1,
      chunks: { create: { chunkKey: marker, ordinal: 0, text: "Local document", terms: { create: [{ term: "local" }, { term: "document" }] } } },
    },
    include: { chunks: { include: { terms: true } } },
  });
  if (document.chunks.length !== 1 || document.chunks[0].terms.length !== 2) throw new Error("Document index relations were not persisted.");

  const [indexed] = await db.$queryRaw`SELECT count(*) AS count FROM message_text_search WHERE message_text_search MATCH '"Local database verification"' AND id=${chat.messages[0].id}`;
  if (Number(indexed.count) !== 1) throw new Error("Conversation search index was not persisted.");

  // Application preferences are a single row that is updated, never duplicated.
  await db.workspacePreference.upsert({ where: { id: preferenceId }, create: { id: preferenceId, settings: { version: 1, defaultMode: "image" } }, update: { settings: { version: 1, defaultMode: "image" } } });
  await db.workspacePreference.upsert({ where: { id: preferenceId }, create: { id: preferenceId, settings: { version: 1, defaultMode: "chat" } }, update: { settings: { version: 1, defaultMode: "chat" } } });
  if (await db.workspacePreference.count() !== 1) throw new Error("Workspace preferences were duplicated.");

  await db.modelRequest.create({ data: { requestId: marker, mode: "image", modelId: "offline/model", status: "success", durationMs: 123, inputTokens: null, outputTokens: null, costUsd: 0, costSource: "configured" } });

  await db.$disconnect();
  if ((await db.workspacePreference.findUnique({ where: { id: preferenceId } })).settings.defaultMode !== "chat") throw new Error("Workspace preferences did not survive reconnect.");
  if ((await db.modelRequest.findFirst({ where: { requestId: marker } })).costUsd !== 0) throw new Error("Usage did not survive reconnect.");

  // Deleting a conversation still cascades to its messages and search index.
  await db.chat.delete({ where: { id: chat.id } });
  const tags = await db.chatTag.count({ where: { chatId: chat.id } });
  const [indexRemainder] = await db.$queryRaw`SELECT count(*) AS count FROM message_text_search WHERE id=${chat.messages[0].id}`;
  if (tags || Number(indexRemainder.count)) throw new Error("Conversation organization or search index did not cascade.");

  await db.memory.delete({ where: { id: memory.id } });
  await db.task.delete({ where: { id: task.id } });
  await db.knowledgeDocument.delete({ where: { id: document.id } });
  await db.mediaAsset.delete({ where: { id: generated.id } });
  await db.mediaAsset.delete({ where: { id: asset.id } });
  await db.modelRequest.deleteMany({ where: { requestId: marker } });
  await db.workspacePreference.deleteMany({ where: { id: preferenceId } });

  const remaining = {
    chats: await db.chat.count({ where: { id: chat.id } }),
    memories: await db.memory.count({ where: { id: memory.id } }),
    tasks: await db.task.count({ where: { id: task.id } }),
    documents: await db.knowledgeDocument.count({ where: { id: document.id } }),
    chunks: await db.documentChunk.count({ where: { documentId: document.id } }),
    terms: await db.documentTerm.count({ where: { chunkId: document.chunks[0].id } }),
    assets: await db.mediaAsset.count({ where: { id: { in: [asset.id, generated.id] } } }),
    references: await db.messageMedia.count({ where: { assetId: asset.id } }),
    generationInputs: await db.mediaGenerationInput.count({ where: { assetId: generated.id } }),
  };
  if (Object.values(remaining).some((count) => count !== 0)) {
    throw new Error(`Cleanup left rows behind: ${JSON.stringify(remaining)}`);
  }

  console.log("Local SQLite database verification passed.");
} finally {
  await db.$disconnect();
}
