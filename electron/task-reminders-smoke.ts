import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Seeds one overdue recurring task for the desktop smoke run.
 *
 * The workspace is single-user, so a task no longer carries an owner column and
 * the fixture only has to confirm that the conversation exists.
 */
export function seedTaskReminderSmoke(databaseFile: string, conversationId: string): string {
  if (process.env.DESKTOP_SMOKE_TEST !== "1") throw new Error("Task fixture requires desktop smoke mode");
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const chat = database.prepare("SELECT id FROM chats WHERE id=?").get(conversationId);
    if (!chat) throw new Error("Smoke conversation is missing");
    const id = randomUUID();
    const due = Date.now() - 60_000;
    database.prepare(`INSERT INTO tasks (id,title,dueDate,timeZone,reminderEnabled,repeatRule,repeatAnchor,updatedAt)
      VALUES (?, 'Desktop task reminder smoke',?,'Asia/Shanghai',1,'daily',?,?)`).run(id, due, due, Date.now());
    return id;
  } finally { database.close(); }
}
