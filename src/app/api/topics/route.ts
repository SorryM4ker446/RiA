import { NextRequest } from "next/server";
import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { topicConfigSchema } from "@/lib/topics/schema";
import { listTopics, saveTopic } from "@/lib/topics/store";
import { topicResponse } from "@/lib/topics/api";
export const GET = protectDataOperation((req: NextRequest) => topicResponse(req, listTopics));
export const POST = protectDataOperation((req: NextRequest) => topicResponse(req, async () => {
  enforceRateLimit("topics"); return saveTopic(topicConfigSchema.parse(await readJsonBody(req, 12_000)));
}));
