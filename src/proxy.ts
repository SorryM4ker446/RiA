import { NextRequest, NextResponse } from "next/server";

const DESKTOP_COOKIE_NAME = "desktop_session";

function forbidden(message: string) {
  return NextResponse.json(
    { error: { code: "UNAUTHORIZED", message } },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

export function proxy(request: NextRequest) {
  // Legacy public videos are imported through authenticated history loading only.
  if (request.nextUrl.pathname.startsWith("/generated-videos/")) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Media must be accessed through its authenticated asset URL" } }, { status: 404 });
  }
  if (process.env.APP_RUNTIME !== "desktop") return NextResponse.next();

  const expectedHost = process.env.DESKTOP_SERVER_HOST;
  const actualHost = request.headers.get("host");
  if (!expectedHost || actualHost !== expectedHost) {
    return forbidden("Desktop API requests are only accepted from the local application host.");
  }

  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();

  const expectedToken = process.env.DESKTOP_SESSION_TOKEN;
  const providedToken = request.cookies.get(DESKTOP_COOKIE_NAME)?.value;
  if (!expectedToken || providedToken !== expectedToken) {
    return forbidden("Desktop API session is missing or invalid.");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/generated-videos/:path*"],
};
