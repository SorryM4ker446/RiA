import { protectDataOperation } from "@/lib/server/data-operations";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";
import { chatModelSchema } from "@/lib/server/request-schemas";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, normalizeApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { logToolExecution } from "@/lib/server/tool-log";
import { assertToolConfiguration, getToolDescriptor, isToolSupportedInMode, type ToolMode } from "@/tools/catalog";
import { persistToolMemory } from "@/tools/memory-policy";

const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";

const runToolSchema = z.strictObject({
  tool: z.string().trim().min(1).max(100),
  input: z.json(),
  modelId: chatModelSchema.optional(),
  mode: z.literal("chat"),
});

async function POSTHandler(req: NextRequest) {
  const startedAt = Date.now();
  let logContext: { toolId: string; requestId?: string } | null = null;
  let succeeded = false;

  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tools");
    const parsed = runToolSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid tool request",
        details: parsed.error.flatten(),
      });
    }

    const toolId = parsed.data.tool.trim();
    const mode = parsed.data.mode as ToolMode;
    logContext = { toolId };

    const descriptor = getToolDescriptor(toolId);
    if (!descriptor) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: `Unsupported tool: ${toolId}`,
      });
    }

    if (!isToolSupportedInMode(toolId, mode)) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: `Tool ${toolId} is not supported in mode: ${mode}`,
      });
    }

    if (!descriptor.manual.enabled) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: `Tool ${toolId} is not available for manual invocation`,
      });
    }

    const parsedInput = descriptor.inputSchema.safeParse(parsed.data.input);
    if (!parsedInput.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid tool input",
        details: parsedInput.error.flatten(),
      });
    }

    assertToolConfiguration(toolId);
    const preparedInput = descriptor.prepareInput
      ? await descriptor.prepareInput({
          workspaceId: LOCAL_WORKSPACE_ID,
          input: parsedInput.data,
          modelId: parsed.data.modelId,
          trigger: "manual",
        })
      : parsedInput.data;
    const preparedParsedInput = descriptor.inputSchema.safeParse(preparedInput);
    if (!preparedParsedInput.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid tool input",
        details: preparedParsedInput.error.flatten(),
      });
    }

    const data = await descriptor.execute({
      workspaceId: LOCAL_WORKSPACE_ID,
      input: preparedParsedInput.data,
      modelId: parsed.data.modelId,
      trigger: "manual",
    });
    const requestId =
      data && typeof data === "object" && "requestId" in data && typeof data.requestId === "string"
        ? data.requestId
        : undefined;
    logContext = { toolId, requestId };

    const assistantText = (
      await descriptor.buildAssistantText({
        input: preparedParsedInput.data,
        output: data,
        modelId: parsed.data.modelId,
        trigger: "manual",
      })
    ).trim();

    try {
      const memoryResult = await persistToolMemory({
        workspaceId: LOCAL_WORKSPACE_ID,
        toolId,
        trigger: "manual",
        state: "output-available",
        input: preparedParsedInput.data,
        output: data,
        assistantText,
        modelId: parsed.data.modelId,
      });

      if (TOOL_DEBUG) {
        console.info("tools.run.memory", {
          toolId,
          trigger: "manual",
          writeDecision: memoryResult.reason,
          written: memoryResult.written,
        });
      }
    } catch (memoryError) {
      console.warn("tools.run memory.persist warning", normalizeApiError(memoryError).code);
    }

    const response = Response.json({
      tool: toolId,
      data,
      assistantText,
    });
    succeeded = true;
    return response;
  } catch (error) {
    console.error("/api/tools/run POST error", normalizeApiError(error).code);
    if (logContext) {
      logToolExecution({
        toolId: logContext.toolId,
        trigger: "manual",
        state: "output-error",
        durationMs: Date.now() - startedAt,
        requestId: logContext.requestId,
        errorCode: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
      });
    }
    return createApiErrorResponse(error, "Failed to run tool");
  } finally {
    if (succeeded && logContext) {
      logToolExecution({
        toolId: logContext.toolId,
        trigger: "manual",
        state: "output-available",
        durationMs: Date.now() - startedAt,
        requestId: logContext.requestId,
      });
    }
  }
}

export const POST = protectDataOperation(POSTHandler);
