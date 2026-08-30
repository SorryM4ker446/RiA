import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";

const loginSchema = z.strictObject({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

function publicUser(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

export async function POST(req: NextRequest) {
  try {
    assertRequestSecurity(req);
    enforceRateLimit("login");
    const parsed = loginSchema.safeParse(await readJsonBody(req, 16 * 1024));

    if (!parsed.success) throw parsed.error;

    const email = parsed.data.email.toLowerCase();
    const user = await db.user.findUnique({ where: { email } });

    if (!user || !user.passwordHash || !verifyPassword(parsed.data.password, user.passwordHash)) {
      throw new ApiError({ code: "UNAUTHORIZED", message: "邮箱或密码不正确。" });
    }

    const token = await createSession(user.id);
    const response = NextResponse.json({ data: publicUser(user) });
    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
    return response;
  } catch (error) { return createApiErrorResponse(error); }
}
