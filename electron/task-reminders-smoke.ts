import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Seeds one notice from a finished task for the desktop smoke run: unread, and
 * not yet handed to the desktop, as the service leaves it when a task ends.
 */
export function seedTaskReminderSmoke(databaseFile: string, conversationId: string): string {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Task fixture requires desktop smoke mode");
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const chat = database.prepare("SELECT id FROM chats WHERE id=?").get(conversationId);
    if (!chat) throw new Error("Smoke conversation is missing");
    const id = randomUUID();
    database.prepare(`INSERT INTO app_notices (id,kind,title,detail,href,fingerprint,updatedAt)
      VALUES (?, 'taskRun', 'task-finished', 'Desktop task notification smoke', ?, ?, ?)`).run(id, `/chat?conversationId=${conversationId}`, `task:${id}`, Date.now());
    return id;
  } finally { database.close(); }
}
