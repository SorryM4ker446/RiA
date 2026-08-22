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
    stored.tasks.length !== 1
  ) {
    throw new Error("Local database relations were not persisted as expected.");
  }

  await db.user.delete({ where: { id: user.id } });
  const remainingChats = await db.chat.count({ where: { userId: user.id } });
  const remainingMemories = await db.memory.count({ where: { userId: user.id } });
  const remainingTasks = await db.task.count({ where: { userId: user.id } });

  if (remainingChats !== 0 || remainingMemories !== 0 || remainingTasks !== 0) {
    throw new Error("Local database cascade deletion did not remove related records.");
  }

  console.log("Local SQLite database verification passed.");
} finally {
  await db.$disconnect();
}
