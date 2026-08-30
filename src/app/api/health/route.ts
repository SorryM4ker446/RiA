import { NextRequest } from "next/server";
import { assertRequestSecurity } from "@/lib/server/request-security";
import { createApiErrorResponse } from "@/lib/server/api-error";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  try { assertRequestSecurity(request); }
  catch (error) { return createApiErrorResponse(error); }

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
