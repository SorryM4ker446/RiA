import {
  ChatSummary,
  ModelMode
} from "@/features/chat/page-utils";
import { UIMessage } from "ai";
import type { ModelRef } from "@/lib/models/preferences-schema";
import type { ToolSurface } from "@/tools/types";

export type ToolDocumentSelection = { id: string; filename: string };

export type ToolCatalogItem = {
  /** Whether the tool can run right now; an unconfigured one is not offered. */
  available: boolean;
  reason: "notConfigured" | "noDirectoryGranted" | "disabled" | "notTested" | "toolDisabled" | null;
  configEntry?: string | null;
  extensionId?: string;
  extensionName?: string;
  id: string;
  displayName: string;
  description: string;
  modeSupport: string[];
  surface: ToolSurface;
  requiresApproval: boolean;
};

export type SkillCatalogItem = { packageId: string; skillId: string; name: string; description: string; plugin: string };

export type ChatScopedPreferences = {
  modelMode: ModelMode;
  selectedChatModel: ModelRef | null;
  selectedImageModel: ModelRef | null;
  selectedVideoModel: ModelRef | null;
};

export type DeleteTarget =
  | { kind: "chat"; chat: ChatSummary }
  | { kind: "message"; message: UIMessage };

export type SearchSourceItem = {
  title: string;
  url: string;
  snippet?: string;
  score?: number | null;
};

export const CHAT_PREFS_STORAGE_PREFIX = "chat:prefs:";
export const LAST_ACTIVE_CHAT_STORAGE_KEY = "chat:last-active-id";
/** The model picker's choice, in a task's conversation, to follow the default chat model. */
export const TASK_DEFAULT_MODEL = "__task_default_model";
export const COLLAPSED_TASK_LIMIT = 3;
