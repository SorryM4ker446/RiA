import { z } from "zod";
import { isSupportedModelId, isSupportedImageModelId, isSupportedVideoModelId } from "@/config/model";
import { IMAGE_MEDIA_TYPES, MEDIA_LIMITS } from "@/lib/media/limits";
import { getToolDescriptor } from "@/tools/catalog";

export const identifierSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const chatModelSchema = z.string().max(200).refine(isSupportedModelId, "Unsupported chat model");
const providerMetadata = z.record(z.string(), z.record(z.string(), z.json())).optional();
const imageReference = z.strictObject({
  url: z.string().max(200).regex(/^\/api\/media\/[a-zA-Z0-9_-]+$/),
  mediaType: z.enum(IMAGE_MEDIA_TYPES).optional(),
});
const textPart = z.strictObject({
  type: z.enum(["text", "reasoning"]), text: z.string().max(100_000),
  state: z.enum(["streaming", "done"]).optional(), providerMetadata,
});
const filePart = imageReference.extend({ type: z.literal("file"), mediaType: z.enum(IMAGE_MEDIA_TYPES), filename: z.string().max(255).optional(), providerMetadata });
const toolPart = z.strictObject({
  type: z.enum(["tool-createTask", "tool-searchKnowledge", "tool-webSearch"]),
  toolCallId: identifierSchema,
  state: z.enum(["input-streaming", "input-available", "approval-requested", "approval-responded", "output-available", "output-error", "output-denied"]),
  input: z.json().optional(), output: z.json().optional(), rawInput: z.json().optional(),
  errorText: z.string().max(16_000).optional(),
  approval: z.strictObject({ id: identifierSchema, approved: z.boolean().optional(), reason: z.string().max(2000).optional() }).optional(),
  providerExecuted: z.boolean().optional(), preliminary: z.boolean().optional(),
  callProviderMetadata: providerMetadata, resultProviderMetadata: providerMetadata,
  title: z.string().max(500).optional(),
}).superRefine((part, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!["input-streaming", "output-error"].includes(part.state) && part.input === undefined) fail("Tool input is required");
  if (part.state === "output-available" && part.output === undefined) fail("Tool output is required");
  if (part.state === "output-error" && !part.errorText) fail("Tool error is required");
  if (part.state.startsWith("approval-") && !part.approval) fail("Approval is required");
  if (part.state === "approval-requested" && part.approval?.approved !== undefined) fail("Pending approval cannot include a decision");
  if (part.state === "approval-responded" && typeof part.approval?.approved !== "boolean") fail("Approval decision is required");
  if (part.state === "output-denied" && part.approval?.approved !== false) fail("Denied output requires a rejected approval");
  if (!["input-streaming", "output-error"].includes(part.state) && !getToolDescriptor(part.type.slice(5))?.inputSchema.safeParse(part.input).success) fail("Invalid tool input");
  if (part.output !== undefined && part.state !== "output-available") fail("Tool output is not allowed in this state");
  if (part.errorText !== undefined && part.state !== "output-error") fail("Tool error is not allowed in this state");
  if (part.approval && ["input-streaming", "input-available"].includes(part.state)) fail("Approval is not allowed in this state");
});

const messageSchema = z.strictObject({
  id: identifierSchema, role: z.enum(["user", "assistant", "system"]),
  metadata: z.json().optional(),
  parts: z.array(z.union([
    textPart, filePart, toolPart,
    z.strictObject({ type: z.literal("step-start") }),
    z.strictObject({ type: z.literal("source-url"), sourceId: identifierSchema, url: z.url().max(2000), title: z.string().max(1000).optional(), providerMetadata }),
    z.strictObject({ type: z.literal("source-document"), sourceId: identifierSchema, mediaType: z.string().max(100), title: z.string().max(1000), filename: z.string().max(255).optional(), providerMetadata }),
  ])).min(1).max(100),
}).superRefine((message, ctx) => {
  if (message.parts.filter((part) => part.type === "file").length > MEDIA_LIMITS.attachmentCount) ctx.addIssue({ code: "custom", message: "Too many image attachments" });
  if (message.role !== "assistant" && message.parts.some((part) => part.type !== "text" && !(message.role === "user" && part.type === "file"))) ctx.addIssue({ code: "custom", message: "Parts are not allowed for this role" });
  if (message.role === "user" && !message.parts.some((part) => part.type === "file" || (part.type === "text" && part.text.trim()))) ctx.addIssue({ code: "custom", message: "User message must contain text or an image" });
});

export const chatRequestSchema = z.strictObject({
  id: identifierSchema.optional(), chatId: identifierSchema.optional(), conversationId: identifierSchema.optional(),
  messageId: identifierSchema.optional(), modelId: chatModelSchema.optional(),
  mode: z.literal("chat").optional(), manualToolsOnly: z.boolean().optional(),
  trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
  messages: z.array(messageSchema).min(1).max(1000),
}).superRefine((body, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (body.chatId && body.conversationId && body.chatId !== body.conversationId) fail("Conversation identifiers disagree");
  if (new Set(body.messages.map((message) => message.id)).size !== body.messages.length) fail("Message identifiers must be unique");
  if (!body.messages.some((message) => message.role === "user")) fail("A user message is required");
  const last = body.messages.at(-1);
  if (last?.role !== "user" && !(last?.role === "assistant" && last.parts.some((part) => "state" in part && part.state === "approval-responded"))) fail("The last message must be a user message or an approval response");
  if (last?.role === "assistant" && !(body.chatId || body.conversationId || body.id)) fail("Approval continuation requires an existing conversation");
  if (last?.role === "assistant" && body.trigger === "regenerate-message") fail("Regeneration cannot resume a tool approval");
});

export const imageRequestSchema = z.strictObject({
  prompt: z.string().trim().max(4000).default(""),
  modelId: z.string().max(200).refine(isSupportedImageModelId, "Unsupported image model").optional(),
  inputImages: z.array(imageReference).max(MEDIA_LIMITS.attachmentCount).default([]),
}).refine((body) => Boolean(body.prompt || body.inputImages.length), "prompt or inputImages is required");

export const videoRequestSchema = z.strictObject({
  prompt: z.string().trim().max(4000).default(""),
  modelId: z.string().max(200).refine(isSupportedVideoModelId, "Unsupported video model").optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
  duration: z.number().int().min(1).max(60).optional(), fps: z.number().int().min(1).max(120).optional(),
  inputImage: imageReference.optional(),
}).refine((body) => Boolean(body.prompt || body.inputImage), "prompt or inputImage is required");
