import { z } from "zod";
import { modelModes, modelRefSchema } from "@/lib/models/preferences-schema";

export const chatModelPreferencesSchema = z.strictObject({
  modelMode: z.enum(modelModes),
  selectedChatModel: modelRefSchema.nullable(),
  selectedImageModel: modelRefSchema.nullable(),
  selectedVideoModel: modelRefSchema.nullable(),
});

export type ChatModelPreferences = z.infer<typeof chatModelPreferencesSchema>;

// Older conversations may only have a chat model recovered from their last answer.
export function readChatModelPreferences(value: unknown): Partial<ChatModelPreferences> | null {
  return chatModelPreferencesSchema.partial().safeParse(value).data ?? null;
}
