// One-off recovery: give the pre-auth demo account a password and report how
// much data is attached to it.
//
// Usage:
//   node --env-file=.env scripts/recover-demo-user.mjs            # generate a password
//   node --env-file=.env scripts/recover-demo-user.mjs "MyPass"   # set a specific password
import { createRequire } from "node:module";
import { randomBytes, scryptSync } from "node:crypto";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const DEMO_EMAIL = "demo@private-ai.local";
const password = process.argv[2] || randomBytes(12).toString("base64url");

function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

const db = new PrismaClient();

const user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });

if (!user) {
  console.log(`No demo user found (${DEMO_EMAIL}). Nothing to recover.`);
  await db.$disconnect();
  process.exit(0);
}

const [chats, messages, memories, tasks] = await Promise.all([
  db.chat.count({ where: { userId: user.id } }),
  db.message.count({ where: { chat: { userId: user.id } } }),
  db.memory.count({ where: { userId: user.id } }),
  db.task.count({ where: { userId: user.id } }),
]);

console.log(`Demo user: ${user.email}`);
console.log(`Data owned: ${chats} chats, ${messages} messages, ${memories} memories, ${tasks} tasks`);

await db.user.update({
  where: { id: user.id },
  data: { passwordHash: hashPassword(password) },
});

console.log("Password set.");
console.log(`LOGIN EMAIL: ${DEMO_EMAIL}`);
console.log(`LOGIN PASSWORD: ${password}`);

await db.$disconnect();
