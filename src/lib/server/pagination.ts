import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";

const cursorSchema = z.strictObject({
  v: z.literal(1), scope: z.string().max(500),
  date: z.iso.datetime(), id: z.string().min(1).max(200),
});
export type PageOptions = { limit: number; cursor?: { date: Date; id: string } };

export function readPageOptions(params: URLSearchParams, scope: string, defaultLimit: number): PageOptions {
  const input = z.strictObject({
    limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().int().max(100)).optional(),
    cursor: z.string().min(1).max(1500).regex(/^[A-Za-z0-9_-]+$/).optional(),
  }).parse(Object.fromEntries(params));
  if (params.getAll("limit").length > 1 || params.getAll("cursor").length > 1) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate pagination parameter" });
  }
  if (!input.cursor) return { limit: input.limit ?? defaultLimit };
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
    if (cursor.scope !== scope) throw new Error("Cursor scope mismatch");
    return { limit: input.limit ?? defaultLimit, cursor: { date: new Date(cursor.date), id: cursor.id } };
  } catch {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid pagination cursor" });
  }
}

export function pageResult<T extends { id: string }>(rows: T[], options: PageOptions, scope: string, date: (row: T) => Date) {
  const data = rows.slice(0, options.limit);
  const last = data.at(-1);
  const nextCursor = rows.length > options.limit && last
    ? Buffer.from(JSON.stringify({ v: 1, scope, date: date(last).toISOString(), id: last.id })).toString("base64url")
    : null;
  return { data, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
}
