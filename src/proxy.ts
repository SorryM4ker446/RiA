import { NextRequest, NextResponse } from "next/server";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";

import { t } from "@/lib/locale";
export function proxy(request: NextRequest) {
  try {
    // Legacy public videos are imported through authenticated history loading only.
    if (request.nextUrl.pathname.startsWith("/generated-videos/")) {
      throw new ApiError({ code: "NOT_FOUND", message: t("server.media.authenticatedUrlOnly") });
    }
    assertRequestSecurity(request);
    return NextResponse.next();
  } catch (error) { return createApiErrorResponse(error); }
}

// Chat reads terminal scripts without a size limit. Skip Proxy's bounded body
// clone; protectDataOperation and requireLocalWorkspace authenticate the route.
export const config = { matcher: ["/api/((?!chat/?$).*)", "/generated-videos/:path*"] };
