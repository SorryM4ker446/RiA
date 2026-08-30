import { NextRequest, NextResponse } from "next/server";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { assertRequestSecurity } from "@/lib/server/request-security";

export function proxy(request: NextRequest) {
  try {
    // Legacy public videos are imported through authenticated history loading only.
    if (request.nextUrl.pathname.startsWith("/generated-videos/")) {
      throw new ApiError({ code: "NOT_FOUND", message: "Media must be accessed through its authenticated asset URL" });
    }
    assertRequestSecurity(request);
    return NextResponse.next();
  } catch (error) { return createApiErrorResponse(error); }
}

export const config = { matcher: ["/api/:path*", "/generated-videos/:path*"] };
