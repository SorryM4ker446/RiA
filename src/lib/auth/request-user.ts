import type { NextRequest } from "next/server";
import { db } from "@/db";
import { getSessionUserFromRequest } from "@/lib/auth/session";
import { ApiError } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";
import { readEmptyBody } from "@/lib/server/request-body";
import { identifyDataUser } from "@/lib/server/data-operations";

const DEFAULT_EMAIL = "demo@private-ai.local";
const DEFAULT_NAME = "Demo User";

export function isAuthDisabled(): boolean {
  return process.env.AUTH_DISABLED === "1";
}

async function resolveDemoUser() {
  return db.user.upsert({
    where: { email: DEFAULT_EMAIL },
    update: {},
    create: {
      email: DEFAULT_EMAIL,
      name: DEFAULT_NAME,
    },
  });
}

/**
 * Returns the currently authenticated user, or null when unauthenticated.
 * When AUTH_DISABLED=1 is set (local dev / E2E escape hatch), falls back to a
 * single shared demo user.
 */
export async function getRequestUser(req: NextRequest) {
  assertRequestSecurity(req);
  if (isAuthDisabled()) return resolveDemoUser();
  return getSessionUserFromRequest(req);
}

/**
 * Like `getRequestUser` but throws a 401 ApiError when no valid session
 * exists. Use this in every protected API route.
 */
export async function requireRequestUser(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) {
    throw new ApiError({
      code: "UNAUTHORIZED",
      message: "Authentication required. Please sign in.",
    });
  }
  if (req.method === "DELETE") await readEmptyBody(req);
  identifyDataUser(user.id);
  return user;
}
