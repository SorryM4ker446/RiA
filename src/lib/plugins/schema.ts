import { createHash } from "node:crypto";
import { z } from "zod";
import { extensionConfigSchema } from "@/lib/extensions/schema";
import { connectionCredentials } from "@/lib/extensions/transport";
import { ApiError } from "@/lib/server/api-error";
import { skillPackageId, skillSnapshotSchema } from "./skill-source";

export const PLUGIN_LIMITS = { packages: 12, bytes: 2_097_152, activeInstructionChars: 24_000 } as const;
const key = z.string().regex(/^[a-z][a-z0-9-]{0,59}$/);
const uniqueIds = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
export const pluginCredentialSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/),
  required: z.boolean().default(false),
  description: z.string().trim().max(240).default(""),
});
export const pluginManifestSchema = z.strictObject({
  format: z.literal("ria-plugin"),
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/),
  name: z.string().trim().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(50),
  description: z.string().trim().min(1).max(400),
  author: z.string().trim().min(1).max(80),
  marketplace: skillSnapshotSchema.optional(),
  skills: z.array(z.strictObject({
    id: key, name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
    instructions: z.string().trim().min(1).max(6000),
  })).max(8).refine(uniqueIds, "Duplicate skill IDs").default([]),
  connections: z.array(z.strictObject({
    id: key, name: z.string().trim().min(1).max(80),
    config: extensionConfigSchema,
    credentials: z.array(pluginCredentialSchema).max(20).default([]),
  })).max(4).refine(uniqueIds, "Duplicate connection IDs").default([]),
}).superRefine((manifest, ctx) => {
  if (manifest.marketplace && (manifest.id !== skillPackageId(manifest.marketplace.repository, manifest.marketplace.skill) || manifest.skills.length !== 1 || manifest.connections.length)) ctx.addIssue({ code: "custom", message: "Marketplace snapshots must contain one skill and no implicit connections" });
  if (!manifest.skills.length && !manifest.connections.length) ctx.addIssue({ code: "custom", message: "A plugin must contain a skill or connection" });
  if (manifest.skills.reduce((sum, skill) => sum + skill.instructions.length, 0) > 12_000) ctx.addIssue({ code: "custom", message: "Plugin instructions exceed 12000 characters" });
  for (const connection of manifest.connections) {
    try {
      const fields = connection.credentials;
      if (new Set(fields.map(field => connection.config.type === "mcp-stdio" && process.platform !== "win32" ? field.key : field.key.toLowerCase())).size !== fields.length) throw new Error();
      connectionCredentials(connection.config, Object.fromEntries(fields.map(field => [field.key, "placeholder"])));
    } catch { ctx.addIssue({ code: "custom", message: "Invalid or duplicate credential fields" }); }
  }
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export function parsePlugin(raw: unknown) {
  const manifest = pluginManifestSchema.parse(raw);
  const serialized = JSON.stringify(manifest);
  if (Buffer.byteLength(serialized) > PLUGIN_LIMITS.bytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "插件包超过 2 MiB。" });
  return { manifest, digest: createHash("sha256").update(serialized).digest("hex") };
}
export const installPluginSchema = z.strictObject({ manifest: pluginManifestSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), allowLocalProcesses: z.boolean().default(false) });
export const pluginStateSchema = z.strictObject({ revision: z.number().int().positive(), enabled: z.boolean() });
