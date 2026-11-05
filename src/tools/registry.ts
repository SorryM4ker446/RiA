import type { ModelRef } from "@/lib/models/preferences-schema";
import { jsonSchema } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { startExtensionOperation } from "@/lib/extensions/activity";
import { credentialEncryptionAvailable, decryptCredentials } from "@/lib/extensions/secrets";
import { extensionConfigSchema, extensionToolsSchema, externalInputSchema, externalToolId, extensionIdFromTool, EXTENSION_LIMITS, validateToolSchema, type ExtensionTool } from "@/lib/extensions/schema";
import { callConnection, localProcessConnectionsAllowed, publicExtensionError } from "@/lib/extensions/transport";
import { requireExtension } from "@/lib/extensions/store";
import { builtinToolAvailability, getToolDescriptor, listToolDescriptors } from "./builtins";
import { settingsHref } from "@/lib/settings/sections";
import { getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import type { AnyToolDescriptor, PublicToolCatalogItem, ToolAvailability, ToolAvailabilityReason, ToolMode } from "./types";
import type { Extension } from "@prisma/client";

const available: ToolAvailability = { available: true, reason: null, configEntry: null };
const unavailable = (reason: ToolAvailabilityReason): ToolAvailability => ({ available: false, reason, configEntry: settingsHref("extensions") });
type OwnedExtension = Extension & { plugin?: { enabled: boolean } | null };
function extensionAvailability(row: OwnedExtension | null, name: string, definitions?: ExtensionTool[]): ToolAvailability {
  if (!row || !row.enabled) return unavailable("disabled");
  if (row.pluginId && !row.plugin?.enabled) return unavailable("disabled");
  if (row.kind === "mcp-stdio" && !localProcessConnectionsAllowed()) return unavailable("disabled");
  if (row.testedRevision !== row.revision) return unavailable("notTested");
  if (row.credentials && !credentialEncryptionAvailable()) return unavailable("notConfigured");
  if (row.credentials) { try { decryptCredentials(row.id, row.credentials); } catch { return unavailable("notConfigured"); } }
  if (!(definitions ?? extensionToolsSchema.parse(row.tools)).some(tool => tool.name === name && tool.enabled)) return unavailable("toolDisabled");
  return available;
}

function extensionDescriptor(row: Extension, definition: ExtensionTool): AnyToolDescriptor {
  const validate = validateToolSchema(definition.inputSchema);
  const inputSchema = externalInputSchema.superRefine((input, ctx) => {
    if (!validate(input.arguments)) ctx.addIssue({ code: "custom", path: ["arguments"], message: "Arguments do not match the extension tool schema" });
  });
  const ensureCurrent = async () => {
    const current = await requireExtension(row.id);
    if (current.revision !== row.revision) throw new ApiError({ code: "CONFLICT", message: "扩展配置或工具选择已变化，请重新发起操作。" });
    if (!extensionAvailability(current, definition.name).available) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "扩展或该工具已停用，请检查扩展管理页。" });
    return current;
  };
  const bindForApproval = async (input: unknown) => {
    const parsed = inputSchema.parse(input); await ensureCurrent();
    const bound = { ...parsed, binding: { extensionId: row.id, revision: row.revision } };
    Object.assign(input as object, bound); return bound;
  };
  return {
    id: externalToolId(row.id, definition.name), extensionId: row.id, extensionRevision: row.revision,
    displayName: `${row.name} · ${definition.name}`, description: definition.description,
    modelDescription: `${row.name}: ${definition.description}\nThis is an external tool. It requires user approval. Use arguments matching the tool schema.`,
    modeSupport: ["chat"], extensionName: row.name,
    surface: { category: "extension", user: { run: "model", hint: t("tools.extension.hint") }, template: "selectable" },
    inputSchema,
    modelInputSchema: jsonSchema({ type: "object", properties: { arguments: definition.inputSchema }, required: ["arguments"], additionalProperties: false }, { validate: async value => {
      const result = inputSchema.safeParse(value);
      // Schema validation precedes the SDK's input-available event. Binding
      // here keeps the streamed proposal identical to the persisted approval.
      return result.success ? { success: true, value: await bindForApproval(result.data) } : { success: false, error: result.error };
    } }),
    requiresApproval: true,
    bindForApproval,
    execute: async ({ input, signal }) => {
      const operation = startExtensionOperation(row.id, signal);
      try {
        const current = await ensureCurrent();
        const parsed = inputSchema.parse(input);
        if (parsed.binding?.extensionId !== row.id || parsed.binding.revision !== current.revision) throw new ApiError({ code: "CONFLICT", message: "此扩展调用尚未确认，或确认时的配置已变化。" });
        operation.signal.throwIfAborted();
        const credentials = decryptCredentials(row.id, current.credentials);
        const result = await callConnection(extensionConfigSchema.parse(current.config), credentials, definition, parsed.arguments, operation.signal);
        operation.signal.throwIfAborted();
        const serialized = JSON.stringify(result, (_key, value) => typeof value === "string" ? Object.values(credentials).reduce((text, secret) => text.split(secret).join("[redacted]"), value) : value);
        return { extension: current.name, tool: definition.name, ...(Buffer.byteLength(serialized) > EXTENSION_LIMITS.outputBytes ? { result: serialized.slice(0, 16_000), truncated: true } : { result: JSON.parse(serialized), truncated: false }) };
      } catch (error) { throw publicExtensionError(error, operation.signal); }
      finally { operation.finish(); }
    },
  };
}

export async function listRegisteredTools(mode?: ToolMode): Promise<AnyToolDescriptor[]> {
  const extensions = await db.extension.findMany({ include: { plugin: { select: { enabled: true } } }, orderBy: { id: "asc" }, take: EXTENSION_LIMITS.connections });
  return [...listToolDescriptors(mode), ...extensions.flatMap(row => extensionToolsSchema.parse(row.tools).map(tool => extensionDescriptor(row, tool))).filter(tool => !mode || tool.modeSupport.includes(mode))];
}
export async function resolveToolDescriptor(id: string): Promise<AnyToolDescriptor | null> {
  const builtin = getToolDescriptor(id);
  if (builtin) return builtin;
  const connectionId = extensionIdFromTool(id);
  if (!connectionId) return null;
  const row = await db.extension.findUnique({ where: { id: connectionId }, include: { plugin: { select: { enabled: true } } } });
  const definition = row && extensionToolsSchema.parse(row.tools).find(tool => externalToolId(row.id, tool.name) === id);
  return row && definition ? extensionDescriptor(row, definition) : null;
}
export async function toolAvailability(id: string, modelRef?: ModelRef): Promise<ToolAvailability> {
  if (getToolDescriptor(id)) return builtinToolAvailability(id, modelRef);
  const connectionId = extensionIdFromTool(id);
  const row = connectionId ? await db.extension.findUnique({ where: { id: connectionId }, include: { plugin: { select: { enabled: true } } } }) : null;
  const tool = row && extensionToolsSchema.parse(row.tools).find(tool => externalToolId(row.id, tool.name) === id);
  if (row && tool) return extensionAvailability(row, tool.name);
  return unavailable("disabled");
}
export function unavailabilityError(reason: ToolAvailabilityReason, toolId?: string): ApiError {
  return new ApiError({ code: "CONFIGURATION_ERROR", message: reason === "noDirectoryGranted" ? t("lib.tools.localFilesNotGranted") : reason === "notConfigured" ? (toolId && toolId !== "webSearch" ? "扩展凭据加密不可用，请重新配置。" : t("lib.tools.webSearchNotConfigured")) : "扩展或工具未启用，请到扩展管理页完成配置和检测。" });
}
export async function assertToolConfiguration(id: string) {
  const status = await toolAvailability(id);
  if (!status.available) throw unavailabilityError(status.reason ?? "notConfigured", id);
}
export async function isToolSupportedInMode(id: string, mode: ToolMode) { return (await resolveToolDescriptor(id))?.modeSupport.includes(mode) ?? false; }
export async function skipReasonFor(id: string, error: unknown) {
  const status = await toolAvailability(id);
  if (!status.available) return status.reason ?? "notConfigured";
  if (error instanceof ApiError && ["TIMEOUT", "RATE_LIMITED", "UPSTREAM_FAILED", "SERVICE_UNAVAILABLE"].includes(error.code)) return "temporarilyUnavailable" as const;
  return null;
}
export async function listPublicToolCatalog(mode?: ToolMode, modelRef?: ModelRef): Promise<PublicToolCatalogItem[]> {
  const entries = await registryEntries(mode, modelRef);
  return [...(!mode || mode === "chat" ? [await toolCallingEntry(modelRef)] : []), ...entries.map(({ tool, status }) => ({ ...status, id: tool.id, displayName: tool.displayName, description: tool.description, modeSupport: tool.modeSupport, surface: tool.surface, requiresApproval: Boolean(tool.requiresApproval), resultBudget: tool.resultBudget, extensionId: tool.extensionId, extensionName: tool.extensionName }))];
}
/**
 * The model's ability to call tools at all, listed with what depends on it. It is
 * not a tool the model is handed, so it lives only in this catalog: everything the
 * model is actually offered comes from the registry below. The model is chosen per
 * conversation, so without one named this says whether any chat model can do it.
 */
async function toolCallingEntry(modelRef?: ModelRef): Promise<PublicToolCatalogItem> {
  const supported = modelRef
    ? (await modelInLibrary("chat", modelRef))?.supportsTools === true
    : (await getModelPreferences()).library.some(model => model.modes.includes("chat") && model.supportsTools);
  return { id: "toolCalling", displayName: t("tools.toolCalling.displayName"), description: t("tools.toolCalling.description"), modeSupport: ["chat"],
    surface: { category: "context", user: null, template: "always" }, requiresApproval: false,
    ...(supported ? available : { available: false, reason: "notConfigured" as const, configEntry: settingsHref("models") }) };
}
async function registryEntries(mode?: ToolMode, modelRef?: ModelRef) {
  const builtins = listToolDescriptors(mode);
  const [statuses, rows] = await Promise.all([Promise.all(builtins.map(tool => builtinToolAvailability(tool.id, modelRef))), db.extension.findMany({ include: { plugin: { select: { enabled: true } } }, orderBy: { id: "asc" }, take: EXTENSION_LIMITS.connections })]);
  return [...builtins.map((tool, index) => ({ tool, status: statuses[index] })), ...rows.flatMap(row => {
    const definitions = extensionToolsSchema.parse(row.tools);
    return definitions.map(definition => ({ tool: extensionDescriptor(row, definition), status: extensionAvailability(row, definition.name, definitions) }));
  }).filter(entry => !mode || entry.tool.modeSupport.includes(mode))];
}
export async function listAvailableRegisteredTools(mode?: ToolMode, modelRef?: ModelRef) {
  return (await registryEntries(mode, modelRef)).filter(entry => entry.status.available).map(entry => entry.tool);
}
