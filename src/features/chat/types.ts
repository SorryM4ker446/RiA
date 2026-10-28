import {
  ChatSummary,
  ModelMode
} from "@/features/chat/page-utils";
import { UIMessage } from "ai";
import type { ModelRef } from "@/lib/models/preferences-schema";

export type ManualToolSelection = "none" | string;
export type ToolDocumentSelection = { id: string; filename: string };

export type ManualToolFieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "datetime-local";
  /** Sent with its default value but never shown: the tool needs it, the user does not choose it. */
  hidden?: boolean;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{
    label: string;
    value: string;
  }>;
};

export type ManualToolMeta = {
  enabled: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  primaryFieldKey: string;
  primaryFieldLabel: string;
  fields: ManualToolFieldMeta[];
};

export type ToolCatalogItem = {
  /** Whether the tool can run right now; an unconfigured one is not offered. */
  available: boolean;
  reason: "notConfigured" | "noDirectoryGranted" | "disabled" | "notTested" | "toolDisabled" | null;
  configEntry?: string | null;
  extensionId?: string;
  id: string;
  displayName: string;
  description: string;
  modeSupport: string[];
  manual: ManualToolMeta;
};

export type ManualToolFieldValues = Record<string, string>;

export type TaskStatusFilter = "all" | "todo" | "in_progress" | "done";

export type TaskScheduleInput = {
  dueDate: string | null;
  timeZone: string;
  reminderEnabled: boolean;
  repeatRule: "none" | "daily" | "weekly" | "monthly";
};

export type TaskItem = {
  id: string;
  title: string;
  details: string | null;
  dueDate: string | null;
  timeZone?: string;
  reminderEnabled?: boolean;
  repeatRule?: TaskScheduleInput["repeatRule"];
  repeatGenerated?: boolean;
  priority: "low" | "medium" | "high";
  status: "todo" | "in_progress" | "done";
  createdAt: string;
  updatedAt: string;
};

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
export const COLLAPSED_TASK_LIMIT = 3;
