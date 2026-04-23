import { NextRequest } from "next/server";
import { z } from "zod";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
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
  try {
    const user = await getOrCreateRequestUser(req);
    const parsed = runToolSchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid tool request",
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const toolId = parsed.data.tool.trim();
    const mode = parsed.data.mode as ToolMode;

    const descriptor = getToolDescriptor(toolId);
    if (!descriptor) {
      return Response.json(
        {
          error: `Unsupported tool: ${toolId}`,
        },
        { status: 400 },
      );
    }

    if (!isToolSupportedInMode(toolId, mode)) {
      return Response.json(
        {
          error: `Tool ${toolId} is not supported in mode: ${mode}`,
        },
        { status: 400 },
      );
    }

    if (!descriptor.manual.enabled) {
      return Response.json(
        {
          error: `Tool ${toolId} is not available for manual invocation`,
        },
        { status: 400 },
      );
    }

    const parsedInput = descriptor.inputSchema.safeParse(parsed.data.input);
    if (!parsedInput.success) {
      return Response.json(
        {
          error: "Invalid tool input",
          details: parsedInput.error.flatten(),
        },
        { status: 400 },
      );
    }

    const data = await descriptor.execute({
      userId: user.id,
      input: parsedInput.data,
      modelId: parsed.data.modelId,
      trigger: "manual",
    });

    const assistantText = (
      await descriptor.buildAssistantText({
        input: parsedInput.data,
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
        input: parsedInput.data,
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

    return Response.json({
      tool: toolId,
      data,
      assistantText,
    });
  } catch (error) {
    console.error("/api/tools/run POST error", error);
    return Response.json({ error: "Failed to run tool" }, { status: 500 });
  }
}
