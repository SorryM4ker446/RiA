import { z } from "zod";
import { assistantIdSchema, assistantSnapshotSchema } from "@/lib/assistants/schema";
import { documentSourceSchema } from "@/lib/documents/types";
import { documentDiagnosticsSchema } from "@/lib/documents/diagnostics";
import { modelRefSchema } from "@/lib/models/preferences-schema";

export const topicIdSchema = assistantIdSchema;
export const topicConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(60), description: z.string().trim().max(500).default(""),
  collections: z.array(z.string().trim().min(1).max(40)).min(1).max(12).refine(names => new Set(names).size === names.length, "Duplicate collections"),
  assistantTemplateId: assistantIdSchema.nullable().default(null),
});
export type TopicConfig = z.infer<typeof topicConfigSchema>;
export const artifactInputSchema = z.strictObject({
  confirm: z.literal(true), requestId: z.string().uuid(), revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(120), kind: z.enum(["report", "plan", "summary"]), brief: z.string().trim().min(1).max(2000),
});
export const artifactStatusSchema = z.enum(["generating", "ready", "needs_review", "failed", "cancelled", "interrupted"]);
export const artifactMetadataSchema = z.strictObject({
  brief: z.string().max(2000), topic: topicConfigSchema, assistant: assistantSnapshotSchema.nullable(), model: modelRefSchema.nullable(),
  responseModelId: z.string().max(200).nullable(), sources: z.array(documentSourceSchema).max(8),
  diagnostics: documentDiagnosticsSchema.nullable(), unknownCitations: z.array(z.string().max(500)).max(16),
});
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;
export type ArtifactInput = z.infer<typeof artifactInputSchema>;
export type TopicSummary = { id: string; config: TopicConfig; revision: number; _count: { chats: number; artifacts: number } };
export type ArtifactSummary = { id: string; title: string; kind: string; status: z.infer<typeof artifactStatusSchema>; errorCode: string | null; createdAt: string; topicRevision: number };
export type ArtifactDetail = ArtifactSummary & { content: string | null; metadata: ArtifactMetadata };
