import { assertRequestSecurity } from "@/lib/server/request-security";
import { readEmptyBody } from "@/lib/server/request-body";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { NextRequest, NextResponse } from "next/server";
import {
  destroySessionByToken,
  getSessionTokenFromRequest,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  try {
    assertRequestSecurity(req);
    await readEmptyBody(req);
    const token = getSessionTokenFromRequest(req);
    await destroySessionByToken(token);

    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE_NAME, "", {
      ...sessionCookieOptions,
      maxAge: 0,
    });
    return response;
  } catch (error) { return createApiErrorResponse(error); }
}
