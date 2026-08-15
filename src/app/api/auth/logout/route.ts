import { NextRequest, NextResponse } from "next/server";
import {
  destroySessionByToken,
  getSessionTokenFromRequest,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const token = getSessionTokenFromRequest(req);
  await destroySessionByToken(token);

  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
