import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { hashPassword } from "@/lib/auth/password";
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "@/lib/auth/session";

const registerSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().trim().max(120).optional(),
});

function publicUser(user: { id: string; email: string; name: string | null }) {
  return { id: user.id, email: user.email, name: user.name };
}

export async function POST(req: NextRequest) {
  const parsed = registerSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "请输入有效的邮箱和至少 8 位的密码。" } },
      { status: 400 },
    );
  }

  const email = parsed.data.email.toLowerCase();

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "该邮箱已注册，请直接登录。" } },
      { status: 409 },
    );
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
}
