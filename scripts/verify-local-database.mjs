import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient();
const marker = randomUUID();
const email = `database-check-${marker}@private-ai.local`;

try {
  const user = await db.user.create({
    data: {
      email,
      name: "Database Check",
      chats: {
        create: {
          title: `Chat ${marker}`,
          messages: {
            create: {
              clientMessageId: marker,
              role: "user",
              content: "Local database verification",
            },
          },
        },
      },
      memories: {
        create: {
          key: `memory-${marker}`,
          value: "Local memory",
          score: 0.9,
          embedding: [0.1, 0.2, 0.3],
        },
      },
      tasks: {
        create: {
          title: `Task ${marker}`,
          priority: "high",
          dueDate: new Date("2026-09-01T00:00:00Z"),
          timeZone: "Asia/Shanghai",
          reminderEnabled: true,
          repeatRule: "daily",
        },
      },
    },
  });

  const stored = await db.user.findUnique({
    where: { id: user.id },
    include: {
      chats: { include: { messages: true } },
      memories: true,
      tasks: true,
    },
  });

  if (
    !stored ||
    stored.chats.length !== 1 ||
    stored.chats[0].messages.length !== 1 ||
    stored.memories.length !== 1 ||
    stored.tasks.length !== 1 ||
    stored.tasks[0].timeZone !== "Asia/Shanghai" ||
    stored.tasks[0].reminderEnabled !== true ||
    stored.tasks[0].repeatRule !== "daily" ||
    stored.tasks[0].remindedAt !== null ||
    stored.tasks[0].repeatGenerated !== false
  ) {
    throw new Error("Local database relations were not persisted as expected.");
  }

  const asset = await db.mediaAsset.create({ data: {
    id: marker, userId: user.id, relativePath: `database-check/${marker}.png`,
    mediaType: "image/png", byteSize: 1, kind: "attachment",
    references: { create: { messageId: stored.chats[0].messages[0].id } },
  }, include: { references: true } });
  if (asset.references.length !== 1) throw new Error("Media references were not persisted.");

  const document = await db.knowledgeDocument.create({ data: {
    userId: user.id, filename: "database-check.txt", format: "txt", byteSize: 5,
    contentHash: marker, pages: [{ pageNumber: null, text: "Local document" }], characterCount: 14, indexVersion: 1,
    chunks: { create: { chunkKey: marker, ordinal: 0, text: "Local document", terms: { create: [{ term: "local" }, { term: "document" }] } } },
  }, include: { chunks: { include: { terms: true } } } });
  if (document.chunks.length !== 1 || document.chunks[0].terms.length !== 2) throw new Error("Document index relations were not persisted.");

  await db.user.delete({ where: { id: user.id } });
  const remainingChats = await db.chat.count({ where: { userId: user.id } });
  const remainingMemories = await db.memory.count({ where: { userId: user.id } });
  const remainingTasks = await db.task.count({ where: { userId: user.id } });
  const remainingAssets = await db.mediaAsset.count({ where: { userId: user.id } });
  const remainingReferences = await db.messageMedia.count({ where: { assetId: marker } });
  const remainingDocuments = await db.knowledgeDocument.count({ where: { userId: user.id } });
  const remainingChunks = await db.documentChunk.count({ where: { documentId: document.id } });
  const remainingTerms = await db.documentTerm.count({ where: { chunkId: document.chunks[0].id } });

  if (remainingChats !== 0 || remainingMemories !== 0 || remainingTasks !== 0 || remainingAssets !== 0 || remainingReferences !== 0 || remainingDocuments !== 0 || remainingChunks !== 0 || remainingTerms !== 0) {
    throw new Error("Local database cascade deletion did not remove related records.");
  }

  console.log("Local SQLite database verification passed.");
} finally {
  await db.$disconnect();
}
