import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { db } from "@/db";

export const SESSION_COOKIE_NAME = "app_session";
export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_DURATION_MS / 1000,
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a session for a user and returns the opaque token to store in the
 * client cookie. Only the SHA-256 hash of the token is persisted.
 */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
    },
  });
  return token;
}

/**
 * Resolves a session token to its user, deleting expired sessions as a
 * side effect. Returns null when the token is missing, unknown, or expired.
 */
export async function resolveUserBySessionToken(token: string | null | undefined) {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  return session.user;
}

export function getSessionTokenFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(SESSION_COOKIE_NAME)?.value;
}

export async function getSessionUserFromRequest(req: NextRequest) {
  return resolveUserBySessionToken(getSessionTokenFromRequest(req));
}

export async function getSessionUserFromCookies() {
  const store = await cookies();
  return resolveUserBySessionToken(store.get(SESSION_COOKIE_NAME)?.value);
}

export async function destroySessionByToken(token: string | null | undefined) {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
