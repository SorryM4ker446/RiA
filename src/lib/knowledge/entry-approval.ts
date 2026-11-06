import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { saveKnowledgeEntry } from "./entries";

const replacedEntrySchema = z.strictObject({ id: z.string(), value: z.string() });

export const saveKnowledgeEntryFields = z.strictObject({
  key: z.string().trim().min(1).max(200).describe("A short title for the entry. Saving under the exact key of an existing entry, as searchKnowledge shows it, replaces that entry's text."),
  value: z.string().trim().min(1).max(4000).describe("The fact itself, in the user's own words."),
  /**
   * Worked out by the server when the model makes the call, never supplied by the model:
   * the entry this call would replace, as the user is shown it before approving.
   */
  binding: z.strictObject({ replaces: replacedEntrySchema.nullable(), stale: z.boolean().optional() }).optional(),
});
export type SaveKnowledgeEntryToolInput = z.infer<typeof saveKnowledgeEntryFields>;
/** What the model is shown and may send: everything but the binding. */
export const saveKnowledgeEntryModelFields = saveKnowledgeEntryFields.omit({ binding: true });

/**
 * Records which entry, if any, the call replaces. Runs when the call is made and again
 * when it is approved: if the entry's text changed in between, what the user approved is
 * no longer what would be replaced, so the call is marked stale and will not be saved.
 */
type EntryBinding = NonNullable<SaveKnowledgeEntryToolInput["binding"]>;
export async function bindEntryReplacement(input: unknown): Promise<SaveKnowledgeEntryToolInput & { binding: EntryBinding }> {
  const parsed = saveKnowledgeEntryFields.parse(input);
  const existing = await db.memory.findUnique({ where: { key: parsed.key } });
  const replaces = existing && existing.value !== parsed.value ? { id: existing.id, value: existing.value } : null;
  const previous = parsed.binding;
  const stale = previous && (previous.stale || previous.replaces?.id !== replaces?.id || previous.replaces?.value !== replaces?.value);
  const binding: EntryBinding = stale ? { ...previous, stale: true } : { replaces };
  Object.assign(input as object, { ...parsed, binding });
  return { ...parsed, binding };
}

/**
 * Saves an approved call: replacing the entry the user saw, or adding a new one. A run the
 * user starts directly is its own approval, so it is bound when it runs.
 */
export async function saveApprovedEntry(input: SaveKnowledgeEntryToolInput, trigger: "manual" | "auto") {
  const { key, value, binding } = trigger === "manual" && !input.binding ? await bindEntryReplacement({ ...input }) : saveKnowledgeEntryFields.parse(input);
  if (!binding) throw new ApiError({ code: "CONFLICT", message: "This entry was not prepared for approval; propose it again." });
  if (binding.stale) throw new ApiError({ code: "CONFLICT", message: `The entry "${key}" changed after this was proposed, so nothing was saved. Search for it again and propose the change anew.` });
  // A call that replaces nothing adds an entry; one with the same key created meanwhile is kept beside it.
  return binding.replaces
    ? saveKnowledgeEntry({ key, value, score: 0.9, onConflict: "replace", expected: binding.replaces })
    : saveKnowledgeEntry({ key, value, score: 0.9, onConflict: "keep-both" });
}
