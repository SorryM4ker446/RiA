// List all user accounts and how much data each one owns.
// Usage: node --env-file=.env scripts/list-users.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const db = new PrismaClient();

const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });

if (users.length === 0) {
  console.log("No users found.");
}

for (const user of users) {
  const [chats, messages, memories, tasks] = await Promise.all([
    db.chat.count({ where: { userId: user.id } }),
    db.message.count({ where: { chat: { userId: user.id } } }),
    db.memory.count({ where: { userId: user.id } }),
    db.task.count({ where: { userId: user.id } }),
  ]);

  console.log(`- ${user.email}`);
  console.log(`    name: ${user.name ?? "(none)"}`);
  console.log(`    password set: ${Boolean(user.passwordHash)}`);
  console.log(`    data: ${chats} chats, ${messages} messages, ${memories} memories, ${tasks} tasks`);
}

await db.$disconnect();
