import { NextRequest, NextResponse } from "next/server";
import { getRequestUser } from "@/lib/auth/request-user";

export async function GET(req: NextRequest) {
  const user = await getRequestUser(req);
  if (!user) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "未登录" } },
      { status: 401 },
    );
  }

  return NextResponse.json({ data: { id: user.id, email: user.email, name: user.name } });
}
