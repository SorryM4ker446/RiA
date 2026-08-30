import { resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import { TOOL_INTENT_CLASSIFIER_SYSTEM } from "@/lib/prompts";
import { normalizeApiError } from "@/lib/server/api-error";
import { listAutoToolDescriptors } from "@/tools/catalog";
import { generateText, Output } from "ai";
import { z } from "zod";

const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";
type AutoToolIntent = string | null;
const autoToolIntentSchema = z.object({
  intent: z.string(),
  shouldUseToolNow: z.boolean(),
  userRequestMode: z.enum(["explicit-action", "topic-question", "ambiguous"]),
  expectedBenefit: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});

export async function detectAutoToolIntent(params: {
  text: string;
  modelId: ReturnType<typeof resolveModelId>;
  autoTools: ReturnType<typeof listAutoToolDescriptors>;
}): Promise<AutoToolIntent> {
  const input = params.text.trim();
  if (!input) return null;
  if (!params.autoTools.length) return null;

  const allowedIds = new Set(params.autoTools.map((tool) => tool.id));
  const toolBrief = params.autoTools
    .map((tool) => {
      const examples = tool.auto.examples?.length
        ? `\n  Examples: ${tool.auto.examples.map((example) => `「${example}」`).join(" / ")}`
        : "";
      return `- ${tool.id}: ${tool.description}\n  Trigger hint: ${tool.auto.intentHint}${examples}`;
    })
    .join("\n");

  try {
    const { output } = await generateText({
      model: getChatModel(params.modelId),
      output: Output.object({
        schema: autoToolIntentSchema,
      }),
      system: TOOL_INTENT_CLASSIFIER_SYSTEM.replace(
        "{{allowedIntents}}",
        Array.from(allowedIds).join(", "),
      ),
      prompt: [
        "Available auto tools:",
        toolBrief,
        "",
        "Latest user message:",
        input,
      ].join("\n"),
    });

    if (TOOL_DEBUG) {
      console.info("auto-tool intent result", {
        intent: output.intent,
        shouldUseToolNow: output.shouldUseToolNow,
        userRequestMode: output.userRequestMode,
        confidence: output.confidence ?? null,
        expectedBenefit: output.expectedBenefit ?? null,
        candidates: Array.from(allowedIds),
      });
    }

    const intent = output.intent.trim();
    if (intent === "none" || !allowedIds.has(intent)) {
      return null;
    }

    if (!output.shouldUseToolNow) {
      return null;
    }

    if (output.userRequestMode !== "explicit-action") {
      return null;
    }

    if (typeof output.confidence === "number" && output.confidence < 0.72) {
      return null;
    }

    if (typeof output.expectedBenefit === "number" && output.expectedBenefit < 0.6) {
      return null;
    }

    return intent;
  } catch (error) {
    console.warn("auto-tool intent classification failed", normalizeApiError(error).code);
    return null;
  }
}
