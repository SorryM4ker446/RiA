import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

function publicUser(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

export async function POST(req: NextRequest) {
  const parsed = loginSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "请输入邮箱和密码。" } },
      { status: 400 },
    );
  }

  const email = parsed.data.email.toLowerCase();
  const user = await db.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash || !verifyPassword(parsed.data.password, user.passwordHash)) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "邮箱或密码不正确。" } },
      { status: 401 },
    );
  }

  const token = await createSession(user.id);
  const response = NextResponse.json({ data: publicUser(user) });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  return response;
}
