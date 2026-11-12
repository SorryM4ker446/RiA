import type { Prisma } from "@prisma/client";
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

/**
 * How many notices the workspace keeps.
 *
 * The list and the unread badge are read together, so the centre is bounded by
 * what the list can show. A repeating notice is one row, but the brief and the
 * summary each write one row per day and nothing ever removed them, so the table
 * grew without bound and — once there were more unread rows than the list
 * returns — the badge reported an unread count the list could not account for.
 */
export const NOTICE_LIMITS = { kept: 200 } as const;

/** Newest first, and the bound is applied in the same order: a list sorted
 * differently from the prune would keep a different two hundred than it shows. */
const noticeOrder = () => [{ createdAt: "desc" as const }, { id: "desc" as const }];

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
  /** False keeps the notice in the app but off the screen: it counts as already handed to the desktop. */
  announce?: boolean;
}, transaction?: Prisma.TransactionClient): Promise<AppNoticeView> {
  const notifiedAt = input.announce === false ? new Date() : null;
  const write = async (tx: Prisma.TransactionClient) => {
    const raised = await tx.appNotice.upsert({
      where: { fingerprint: input.fingerprint },
      create: {
        kind: input.kind,
        title: input.title.slice(0, 200),
        detail: (input.detail ?? null)?.slice(0, 2000) ?? null,
        href: input.href ?? null,
        fingerprint: input.fingerprint.slice(0, 200),
        notifiedAt,
      },
      update: {
        title: input.title.slice(0, 200),
        detail: (input.detail ?? null)?.slice(0, 2000) ?? null,
        href: input.href ?? null,
        // Reopening is the point: the thing is still true, so it is still on the list.
        readAt: null,
        // And it is announced again, since what it says has happened again,
        // unless whoever raised it asked for it to stay off the screen.
        notifiedAt
      },
      select: noticeSelect
    });
    // Raising is the only thing that adds a row, so it is the only place the
    // bound has to hold. It is in the same transaction as the raise so a notice
    // is never left outside the bound by two of them landing together.
    const stale = await tx.appNotice.findMany({
      orderBy: noticeOrder(),
      skip: NOTICE_LIMITS.kept,
      take: NOTICE_LIMITS.kept,
      select: { id: true }
    });
    if (stale.length > 0) await tx.appNotice.deleteMany({ where: { id: { in: stale.map((notice) => notice.id) } } });
    return raised;
  };
  const row = transaction ? await write(transaction) : await db.$transaction(write);
  return toView(row);
}

export async function listNotices(options: { includeRead?: boolean } = {}): Promise<AppNoticeView[]> {
  const rows = await db.appNotice.findMany({
    where: options.includeRead ? {} : { readAt: null },
    orderBy: noticeOrder(),
    // The same bound the raise applies, so the list can always account for
    // every unread row the badge counts.
    take: NOTICE_LIMITS.kept,
    select: noticeSelect
  });
  return rows.map(toView);
}

export async function unreadNoticeCount(): Promise<number> {
  return db.appNotice.count({ where: { readAt: null } });
}

/** Notice kinds the desktop also shows as a system notification. */
const ANNOUNCED_KINDS = ["taskRun"];

/**
 * Hand over the notices the desktop has not yet shown, once each.
 *
 * They are marked before the notification is requested, so two checks landing
 * together or a restart cannot show one twice. That makes delivery at most
 * once: a notification the system then refuses is not retried, and the notice
 * itself stays in the app either way.
 */
export async function claimNoticesToAnnounce(now = new Date()): Promise<AppNoticeView[]> {
  return db.$transaction(async tx => {
    const rows = await tx.appNotice.findMany({
      where: { kind: { in: ANNOUNCED_KINDS }, readAt: null, notifiedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 10, select: noticeSelect,
    });
    await tx.appNotice.updateMany({ where: { id: { in: rows.map(row => row.id) }, notifiedAt: null }, data: { notifiedAt: now } });
    return rows.map(toView);
  });
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
