import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export function seedTaskReminderSmoke(databaseFile: string, conversationId: string): string {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Task fixture requires desktop smoke mode");
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const chat = database.prepare("SELECT userId FROM chats WHERE id=?").get(conversationId);
    if (!chat || typeof chat.userId !== "string") throw new Error("Smoke conversation owner is missing");
    const id = randomUUID();
    const due = Date.now() - 60_000;
    database.prepare(`INSERT INTO tasks (id,userId,title,dueDate,timeZone,reminderEnabled,repeatRule,repeatAnchor,updatedAt)
      VALUES (?,?,'Desktop task reminder smoke',?,'Asia/Shanghai',1,'daily',?,?)`).run(id, chat.userId, due, due, Date.now());
    return id;
  } finally { database.close(); }
}
