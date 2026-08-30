import type { ManualToolFieldMeta, ManualToolFieldValues, ToolCatalogItem } from "@/features/chat/types";

export function buildDefaultManualFieldValues(tool: ToolCatalogItem | null): ManualToolFieldValues {
  if (!tool) return {};

  const defaults: ManualToolFieldValues = {};
  for (const field of tool.manual.fields) {
    if (typeof field.defaultValue === "string") {
      defaults[field.key] = field.defaultValue;
    }
  }
  return defaults;
}

export function getManualToolFieldError(field: ManualToolFieldMeta, rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value && !field.required) {
    return null;
  }

  if (!value && field.required) {
    return "请填写此项";
  }

  if (field.type !== "number") {
    return null;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return "请输入有效数字";
  }

  if (typeof field.min === "number" && parsed < field.min) {
    return `最小值为 ${field.min}`;
  }

  if (typeof field.max === "number" && parsed > field.max) {
    return `最大值为 ${field.max}`;
  }

  return null;
}

export function validateManualToolFields(tool: ToolCatalogItem, fieldValues: ManualToolFieldValues): ManualToolFieldValues {
  const errors: ManualToolFieldValues = {};
  for (const field of tool.manual.fields) {
    const error = getManualToolFieldError(field, fieldValues[field.key] ?? field.defaultValue ?? "");
    if (error) {
      errors[field.key] = error;
    }
  }
  return errors;
}

export function normalizeManualToolInput(params: {
  tool: ToolCatalogItem;
  text: string;
  fieldValues: ManualToolFieldValues;
}): Record<string, unknown> {
  const inputPayload: Record<string, unknown> = {
    [params.tool.manual.primaryFieldKey]: params.text,
  };

  for (const field of params.tool.manual.fields) {
    const rawValue = params.fieldValues[field.key] ?? field.defaultValue ?? "";
    if (!rawValue && !field.required) {
      continue;
    }

    if (field.type === "number") {
      const parsed = Number.parseFloat(rawValue);
      if (!Number.isFinite(parsed)) {
        continue;
      }
      inputPayload[field.key] = parsed;
      continue;
    }

    if (rawValue) {
      inputPayload[field.key] = rawValue;
    }
  }

  if (params.tool.id === "createTask" && inputPayload.dueDate) {
    inputPayload.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return inputPayload;
}
