import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { createTask, listTasks, taskInputSchema } from "@/lib/scheduler/jobs";
import { settleAnsweredApprovals } from "@/lib/scheduler/runner";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    // An approval answered some other way — a new message past it — is caught here.
    await settleAnsweredApprovals().catch(() => console.error("task.approval.settle_failed"));
    // Whether tasks run by themselves here: only the desktop service keeps a poller.
    return Response.json({ data: await listTasks(), automaticExecution: process.env.APP_RUNTIME === "desktop" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to list tasks");
  }
});

export const POST = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tasks");
    const parsed = taskInputSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid task", details: parsed.error.flatten() });
    return Response.json({ data: await createTask(parsed.data) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to create task");
  }
});
