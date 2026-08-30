import {
  type SupportedImageModelId,
  type SupportedModelId,
  type SupportedVideoModelId
} from "@/config/model";
import {
  ChatSummary,
  ModelMode
} from "@/features/chat/page-utils";
import { UIMessage } from "ai";

export type ManualToolSelection = "none" | string;

export type ManualToolFieldMeta = {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "datetime-local";
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
  id: string;
  displayName: string;
  description: string;
  modeSupport: string[];
  manual: ManualToolMeta;
  auto: {
    enabled: boolean;
    intentHint: string;
  };
};

export type ManualToolFieldValues = Record<string, string>;

export type TaskStatusFilter = "all" | "todo" | "in_progress" | "done";

export type TaskItem = {
  id: string;
  title: string;
  details: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high";
  status: "todo" | "in_progress" | "done";
  createdAt: string;
  updatedAt: string;
};

export type ChatScopedPreferences = {
  modelMode: ModelMode;
  selectedChatModel: SupportedModelId;
  selectedImageModel: SupportedImageModelId;
  selectedVideoModel: SupportedVideoModelId;
  selectedManualTool: ManualToolSelection;
  manualToolsOnly: boolean;
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
export const COLLAPSED_CHAT_LIMIT = 5;
export const COLLAPSED_TASK_LIMIT = 3;
