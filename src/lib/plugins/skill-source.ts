import { createHash } from "node:crypto";
import { z } from "zod";

export const skillRepositorySchema = z.string().max(140).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/).refine(value => !value.split("/").some(part => part === "." || part === ".."));
export const skillSlugSchema = z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/);
export const skillFileSchema = z.strictObject({
  path: z.string().min(1).max(300).refine(value => !/[\\:\u0000-\u001f\u007f]/.test(value) && value.split("/").every(part => !!part && part !== "." && part !== ".."), "Unsafe skill file path"),
  contents: z.string().max(500_000).refine(value => !value.includes("\0"), "Binary skill files are unsupported"),
});
export const skillSnapshotSchema = z.strictObject({
  provider: z.literal("skills.sh"), repository: skillRepositorySchema, skill: skillSlugSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(skillFileSchema).min(1).max(256),
}).superRefine((snapshot, ctx) => {
  if (!snapshot.files.some(file => file.path === "SKILL.md" && file.contents.trim())) ctx.addIssue({ code: "custom", message: "Snapshot is missing SKILL.md" });
  if (new Set(snapshot.files.map(file => file.path.toLowerCase())).size !== snapshot.files.length) ctx.addIssue({ code: "custom", message: "Duplicate snapshot files" });
  if (snapshotHash(snapshot.files) !== snapshot.contentHash) ctx.addIssue({ code: "custom", message: "Skill snapshot content hash mismatch" });
});
export function snapshotHash(files: { path: string; contents: string }[]) {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.contents]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
export function skillPackageId(repository: string, skill: string) {
  return `skills.sh.${createHash("sha256").update(`${repository.toLowerCase()}/${skill}`).digest("hex").slice(0, 40)}`;
}
