import { db } from "@/db";

/*
 * What the app wants the user to know, kept in the app.
 *
 * A system notification is not a record. It can be refused, suppressed while
 * the machine is in focus, or missed entirely, and a message that only ever
 * existed on screen is gone by the time the user looks for it. So the notice is
 * written here first and the notification, if any, is a convenience on top.
 *
 * `fingerprint` is what makes a repeating notice one row rather than a new one
 * each time: a backup reminder that fires every morning should stay one item
 * until it is dealt with, not become a wall.
 */

export type AppNoticeView = {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  href: string | null;
  createdAt: string;
  readAt: string | null;
};

const noticeSelect = {
  id: true,
  kind: true,
  title: true,
  detail: true,
  href: true,
  createdAt: true,
  readAt: true
} as const;

function toView(row: {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  href: string | null;
  createdAt: Date;
  readAt: Date | null;
}): AppNoticeView {
  return { ...row, createdAt: row.createdAt.toISOString(), readAt: row.readAt?.toISOString() ?? null };
}

/**
 * Raise a notice, or refresh the one it repeats.
 *
 * A repeat marks the existing row unread again rather than adding a row, so the
 * reminder centre shows "this is still outstanding" instead of a list of the
 * same warning.
 */
export async function raiseNotice(input: {
  kind: string;
  title: string;
  detail?: string | null;
  href?: string | null;
  fingerprint: string;
}): Promise<AppNoticeView> {
  const row = await db.appNotice.upsert({
    where: { fingerprint: input.fingerprint },
    create: {
      kind: input.kind,
      title: input.title.slice(0, 200),
      detail: (input.detail ?? null)?.slice(0, 2000) ?? null,
      href: input.href ?? null,
      fingerprint: input.fingerprint.slice(0, 200)
    },
    update: {
      title: input.title.slice(0, 200),
      detail: (input.detail ?? null)?.slice(0, 2000) ?? null,
      href: input.href ?? null,
      // Reopening is the point: the thing is still true, so it is still on the list.
      readAt: null
    },
    select: noticeSelect
  });
  return toView(row);
}

export async function listNotices(options: { includeRead?: boolean } = {}): Promise<AppNoticeView[]> {
  const rows = await db.appNotice.findMany({
    where: options.includeRead ? {} : { readAt: null },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
    select: noticeSelect
  });
  return rows.map(toView);
}

export async function unreadNoticeCount(): Promise<number> {
  return db.appNotice.count({ where: { readAt: null } });
}

export async function markNoticeRead(id: string): Promise<{ read: boolean }> {
  const existing = await db.appNotice.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { read: true };
  await db.appNotice.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } });
  return { read: true };
}

export async function markAllNoticesRead(): Promise<{ read: number }> {
  const result = await db.appNotice.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
  return { read: result.count };
}

export async function deleteNotice(id: string): Promise<{ deleted: boolean }> {
  const existing = await db.appNotice.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { deleted: false };
  await db.appNotice.delete({ where: { id } });
  return { deleted: true };
}
