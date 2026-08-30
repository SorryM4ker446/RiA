import { NextRequest } from "next/server";
import { readEmptyBody } from "@/lib/server/request-body";
import { requireRequestUser } from "@/lib/auth/request-user";
import { cleanupMedia } from "@/lib/media/storage";
import { createApiErrorResponse } from "@/lib/server/api-error";

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    await readEmptyBody(req);
    return Response.json({ data: await cleanupMedia(user.id) });
  } catch (error) { return createApiErrorResponse(error, "Failed to clean unused media"); }
}
