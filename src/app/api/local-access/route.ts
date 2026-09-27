import { NextRequest, NextResponse } from "next/server";
import { createApiErrorResponse, ApiError } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";
import {
  LOCAL_ACCESS_COOKIE,
  LOCAL_HANDSHAKE_QUERY,
  consumeHandshakeCode,
  isTopLevelLocalNavigation,
  localAccessToken,
} from "@/lib/server/local-access";
import { t } from "@/lib/locale";

/**
 * Local entry point for browser development.
 *
 * Opening the application on this machine exchanges the short-lived handshake
 * code printed by the dev server for an HttpOnly access cookie, then redirects
 * into the workspace. There is no login form and no endpoint that hands out a
 * credential to a caller that merely knows the address: the request must be a
 * top-level navigation from this machine and must carry the current code.
 */
export function GET(request: NextRequest) {
  try {
    assertRequestSecurity(request);
    if (!isTopLevelLocalNavigation(request)) {
      throw new ApiError({ code: "FORBIDDEN", message: t("api.localAccess.notTopLevel") });
    }
    const code = request.nextUrl.searchParams.get(LOCAL_HANDSHAKE_QUERY);
    if (!consumeHandshakeCode(code)) {
      throw new ApiError({ code: "FORBIDDEN", message: t("api.localAccess.codeExpired") });
    }

    // Keep the browser's original host: NextURL normalizes loopback IPs to
    // localhost, which would leave this host-only cookie on the entry host.
    const response = new NextResponse(null, {
      status: 303,
      headers: { Location: "/chat", "Cache-Control": "no-store" },
    });
    response.cookies.set(LOCAL_ACCESS_COOKIE, localAccessToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
    });
    return response;
  } catch (error) {
    return createApiErrorResponse(error, t("api.localAccess.establishFailed"));
  }
}
