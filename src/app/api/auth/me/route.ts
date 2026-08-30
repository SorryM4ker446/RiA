import { createApiErrorResponse } from "@/lib/server/api-error";
import { NextRequest, NextResponse } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";

export async function GET(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);

    return NextResponse.json({ data: { id: user.id, email: user.email, name: user.name } });
  } catch (error) { return createApiErrorResponse(error); }
}
