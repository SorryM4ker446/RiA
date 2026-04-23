import { db } from "@/db";

const LEGACY_TOOL_MEMORY_MARKERS = ["type=manual-tool-input", "type=manual-tool-output"] as const;

export async function cleanupLegacyToolMemories(params?: {
  userId?: string;
  dryRun?: boolean;
}) {
  const dryRun = params?.dryRun !== false;
  const where = {
    ...(params?.userId ? { userId: params.userId } : {}),
    OR: LEGACY_TOOL_MEMORY_MARKERS.map((marker) => ({
      value: {
        contains: marker,
      },
    })),
  };

  const matched = await db.memory.findMany({
    where,
    select: {
      id: true,
    },
  });

  if (dryRun || matched.length === 0) {
    return {
      dryRun,
      matched: matched.length,
      deleted: 0,
    };
  }

  const deletion = await db.memory.deleteMany({
    where: {
      id: {
        in: matched.map((item) => item.id),
      },
    },
  });

  return {
    dryRun,
    matched: matched.length,
    deleted: deletion.count,
  };
}

