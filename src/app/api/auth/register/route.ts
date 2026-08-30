import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";

const registerSchema = z.strictObject({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(120).optional(),
});

function publicUser(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

export async function POST(req: NextRequest) {
  try {
    assertRequestSecurity(req);
    enforceRateLimit("register");
    const parsed = registerSchema.safeParse(await readJsonBody(req, 16 * 1024));

    if (!parsed.success) throw parsed.error;

    const email = parsed.data.email.toLowerCase();

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError({ code: "CONFLICT", message: "该邮箱已注册，请直接登录。" });
    }

    const user = await db.user.create({
      data: {
        email,
        name: parsed.data.name || null,
        passwordHash: hashPassword(parsed.data.password),
      },
    });

    const token = await createSession(user.id);
    const response = NextResponse.json({ data: publicUser(user) }, { status: 201 });
    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
    return response;
  } catch (error) { return createApiErrorResponse(error); }
}
