import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";

export const EXTENSION_LIMITS = { connections: 20, tools: 64, enabledTools: 32, schemaBytes: 16_384, responseBytes: 524_288, outputBytes: 32_768, timeoutMs: 20_000 } as const;
export const externalToolIdPattern = /^ext[a-f0-9]{56}$/;
export const extensionIdSchema = z.string().uuid();
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false, ownProperties: true, code: { optimize: false }, loopRequired: 20, loopEnum: 20 });

export function validateToolSchema(value: unknown) {
  const walk = (node: unknown, depth: number) => {
    if (depth > 16) throw new Error("Schema too deep");
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (["$ref", "$dynamicRef", "$recursiveRef", "pattern", "patternProperties"].includes(key)) throw new Error("Unsupported schema keyword");
      walk(child, depth + 1);
    }
  };
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { type?: unknown }).type !== "object") throw new Error();
    if (Buffer.byteLength(JSON.stringify(value)) > EXTENSION_LIMITS.schemaBytes) throw new Error();
    walk(value, 0);
    const validate = ajv.compile(value);
    ajv.removeSchema(value);
    return validate;
  } catch {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "工具参数必须是有效的 JSON Schema 对象（最多 16 KiB，不支持引用或正则规则）。" });
  }
}

export const inputSchemaSchema = z.record(z.string(), z.json()).superRefine((value, ctx) => {
  try { validateToolSchema(value); } catch { ctx.addIssue({ code: "custom", message: "Invalid or unsupported tool JSON Schema" }); }
});
const endpoint = z.string().trim().max(2048).refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
}, "Use an HTTP(S) URL without credentials, a query string or a fragment");
export const extensionConfigSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("mcp-http"), url: endpoint }),
  z.strictObject({ type: z.literal("mcp-stdio"), command: z.string().trim().min(1).max(2000), args: z.array(z.string().max(2000)).max(32).default([]), cwd: z.string().trim().min(1).max(2000), processPermission: z.literal(true) }),
  z.strictObject({ type: z.literal("http"), url: endpoint, method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), description: z.string().trim().min(1).max(2000), inputSchema: inputSchemaSchema }),
]);
export type ExtensionConfig = z.infer<typeof extensionConfigSchema>;
export const credentialSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/), z.string().min(1).max(4096)).refine(value => Object.keys(value).length <= 20);
export const saveExtensionSchema = z.strictObject({ name: z.string().trim().min(1).max(80), config: extensionConfigSchema, credentials: credentialSchema.optional(), clearCredentials: z.boolean().optional(), revision: z.number().int().positive().optional() });
export type SaveExtension = z.infer<typeof saveExtensionSchema>;
export const extensionToolSchema = z.strictObject({ name: z.string().min(1).max(200), description: z.string().max(2000), inputSchema: inputSchemaSchema, enabled: z.boolean().default(false) });
export const extensionToolsSchema = z.array(extensionToolSchema).max(EXTENSION_LIMITS.tools).refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length);
export type ExtensionTool = z.infer<typeof extensionToolSchema>;
export const activationSchema = z.strictObject({ revision: z.number().int().positive(), enabled: z.boolean(), tools: z.array(z.string().min(1).max(200)).max(EXTENSION_LIMITS.tools) });
export const bindingSchema = z.strictObject({ extensionId: extensionIdSchema, revision: z.number().int().positive() });
export const externalInputSchema = z.strictObject({ arguments: z.record(z.string(), z.json()), binding: bindingSchema.optional() });
export type ExternalInput = z.infer<typeof externalInputSchema>;
// Provider function names stay below 64 characters. The connection identity is
// reversible so resolving one tool never loads every connection's schemas.
export const externalToolId = (extensionId: string, name: string) => `ext${extensionId.replaceAll("-", "")}${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
export function extensionIdFromTool(id: string) {
  if (!externalToolIdPattern.test(id)) return null;
  const value = id.slice(3, 35);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
