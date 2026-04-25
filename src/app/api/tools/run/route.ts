import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { logToolExecution } from "@/lib/server/tool-log";
import { getToolDescriptor, isToolSupportedInMode, type ToolMode } from "@/tools/catalog";
import { persistToolMemory } from "@/tools/memory-policy";

const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";

const runToolSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown(),
  modelId: z.string().optional(),
  mode: z.literal("chat"),
});

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let logContext: { toolId: string; userId: string; requestId?: string } | null = null;
  let succeeded = false;

  try {
    const user = await getOrCreateRequestUser(req);
    const parsed = runToolSchema.safeParse(await req.json());

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid tool request",
        details: parsed.error.flatten(),
      });
    }

    const toolId = parsed.data.tool.trim();
    const mode = parsed.data.mode as ToolMode;
    logContext = { toolId, userId: user.id };

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

    const preparedInput = descriptor.prepareInput
      ? await descriptor.prepareInput({
          userId: user.id,
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
      userId: user.id,
      input: preparedParsedInput.data,
      modelId: parsed.data.modelId,
      trigger: "manual",
    });
    const requestId =
      data && typeof data === "object" && "requestId" in data && typeof data.requestId === "string"
        ? data.requestId
        : undefined;
    logContext = { toolId, userId: user.id, requestId };

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
        userId: user.id,
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
      console.warn("tools.run memory.persist warning", memoryError);
    }

    succeeded = true;
    return Response.json({
      tool: toolId,
      data,
      assistantText,
    });
  } catch (error) {
    console.error("/api/tools/run POST error", error);
    if (succeeded && logContext) {
      logToolExecution({
        toolId: logContext.toolId,
        trigger: "manual",
        state: "output-error",
        durationMs: Date.now() - startedAt,
        userId: logContext.userId,
        requestId: logContext.requestId,
        errorCode: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
      });
    }
    return createApiErrorResponse(error, "Failed to run tool");
  } finally {
    if (logContext) {
      logToolExecution({
        toolId: logContext.toolId,
        trigger: "manual",
        state: "output-available",
        durationMs: Date.now() - startedAt,
        userId: logContext.userId,
        requestId: logContext.requestId,
      });
    }
  }
}
