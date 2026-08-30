import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  if (process.env.APP_RUNTIME === "desktop") {
    const expectedHost = process.env.DESKTOP_SERVER_HOST;
    if (!expectedHost || request.headers.get("host") !== expectedHost) {
      return Response.json({ status: "error" }, { status: 403 });
    }
  }

  return Response.json(
    { status: "ok" },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
