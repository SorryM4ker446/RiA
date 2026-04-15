import { NextRequest } from "next/server";
import { db } from "@/db";

const DEFAULT_EMAIL = "demo@private-ai.local";
const DEFAULT_NAME = "Demo User";

export async function getOrCreateRequestUser(req: NextRequest) {
  const userId = req.headers.get("x-user-id")?.trim();
  if (userId) {
    const existingById = await db.user.findUnique({ where: { id: userId } });
    if (existingById) {
      return existingById;
    }
  }

  const emailHeader = req.headers.get("x-user-email")?.trim().toLowerCase();
  const email = emailHeader && emailHeader.length > 0 ? emailHeader : DEFAULT_EMAIL;

  return db.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: DEFAULT_NAME,
    },
  });
}
