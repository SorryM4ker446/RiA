// Compatibility exports for built-in schemas and callers that inspect built-in tools.
// Runtime discovery and execution use the unified registry, including extensions.
export * from "./types";
export { getToolDescriptor, listToolDescriptors } from "./builtins";
export { listPublicToolCatalog, resolveToolDescriptor, toolAvailability, assertToolConfiguration, skipReasonFor, isToolSupportedInMode } from "./registry";
export { createChatToolSet, executeRegisteredTool } from "./execution";
