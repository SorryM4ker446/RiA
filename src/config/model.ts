type ChatModelConfig = {
  id: string;
  label: string;
  description: string;
  supportsImageInput: boolean;
};

type ImageModelConfig = {
  id: string;
  label: string;
  description: string;
  supportsImageInput: boolean;
};

type VideoModelConfig = {
  id: string;
  label: string;
  description: string;
  supportsImageInput: boolean;
};

export const OPENROUTER_MODELS = [
  {
    id: "anthropic/claude-opus-4.6",
    label: "Claude Opus 4.6",
    description: "高质量复杂任务",
    supportsImageInput: true,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "deepseek-v4-pro",
    description: "DeepSeek",
    supportsImageInput: false,
  },
  {
    id: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    description: "高速推理",
    supportsImageInput: true,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "deepseek-v4-flash",
    description: "deepseek-flash",
    supportsImageInput: false,
  },
  {
    id: "minimax/minimax-m2.7",
    label: "MiniMax M2.7",
    description: "Agent/代码任务",
    supportsImageInput: false,
  },
  {
    id: "minimax/minimax-m2.5",
    label: "MiniMax M2.5",
    description: "高效多任务",
    supportsImageInput: false,
  },
  {
    id: "xiaomi/mimo-v2-pro",
    label: "MiMo V2 Pro",
    description: "大上下文 Agent",
    supportsImageInput: false,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B (free)",
    description: "免费可用",
    supportsImageInput: false,
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description: "稳定工作",
    supportsImageInput: true,
  },
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    description: "低延迟低成本",
    supportsImageInput: true,
  },
] as const satisfies readonly ChatModelConfig[];

export type SupportedModelId = (typeof OPENROUTER_MODELS)[number]["id"];

export const DEFAULT_MODEL: SupportedModelId = OPENROUTER_MODELS[0].id;

export const OPENROUTER_IMAGE_MODELS = [
  {
    id: "google/gemini-2.5-flash-image",
    label: "Nano Banana (Gemini 2.5 Flash Image)",
    description: "性价比高",
    supportsImageInput: true,
  },
  {
    id: "google/gemini-3.1-flash-image-preview",
    label: "Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
    description: "速度与质量平衡",
    supportsImageInput: true,
  },
  {
    id: "google/gemini-3-pro-image-preview",
    label: "Nano Banana Pro (Gemini 3 Pro Image Preview)",
    description: "高保真复杂生成",
    supportsImageInput: true,
  },
  {
    id: "bytedance-seed/seedream-4.5",
    label: "Seedream 4.5",
    description: "写实与编辑一致性",
    supportsImageInput: true,
  },
  {
    id: "openai/gpt-5-image-mini",
    label: "GPT-5 Image Mini",
    description: "低延迟",
    supportsImageInput: true,
  },
  {
    id: "openai/gpt-5-image",
    label: "GPT-5 Image",
    description: "高质量图文一体",
    supportsImageInput: true,
  },
] as const satisfies readonly ImageModelConfig[];

export type SupportedImageModelId = (typeof OPENROUTER_IMAGE_MODELS)[number]["id"];

export const DEFAULT_IMAGE_MODEL: SupportedImageModelId = OPENROUTER_IMAGE_MODELS[0].id;

export const OPENROUTER_VIDEO_MODELS = [
  {
    id: "bytedance/seedance-2.0",
    label: "Seedance 2.0",
    description: "高质量视频生成",
    supportsImageInput: true,
  },
  {
    id: "bytedance/seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    description: "快速视频生成",
    supportsImageInput: true,
  },
  {
    id: "openai/sora-2-pro",
    label: "Sora 2 Pro",
    description: "高保真视频生成",
    supportsImageInput: true,
  },
] as const satisfies readonly VideoModelConfig[];

export type SupportedVideoModelId = (typeof OPENROUTER_VIDEO_MODELS)[number]["id"];

export const DEFAULT_VIDEO_MODEL: SupportedVideoModelId = OPENROUTER_VIDEO_MODELS[0].id;

export function isSupportedModelId(value: string): value is SupportedModelId {
  return OPENROUTER_MODELS.some((model) => model.id === value);
}

export function resolveModelId(value: string | undefined): SupportedModelId {
  if (!value) return DEFAULT_MODEL;
  return isSupportedModelId(value) ? value : DEFAULT_MODEL;
}

export function chatModelSupportsImageInput(value: SupportedModelId): boolean {
  return OPENROUTER_MODELS.find((model) => model.id === value)?.supportsImageInput ?? false;
}

export function isSupportedImageModelId(value: string): value is SupportedImageModelId {
  return OPENROUTER_IMAGE_MODELS.some((model) => model.id === value);
}

export function resolveImageModelId(value: string | undefined): SupportedImageModelId {
  if (!value) return DEFAULT_IMAGE_MODEL;
  return isSupportedImageModelId(value) ? value : DEFAULT_IMAGE_MODEL;
}

export function imageModelSupportsImageInput(value: SupportedImageModelId): boolean {
  return OPENROUTER_IMAGE_MODELS.find((model) => model.id === value)?.supportsImageInput ?? false;
}

export function isSupportedVideoModelId(value: string): value is SupportedVideoModelId {
  return OPENROUTER_VIDEO_MODELS.some((model) => model.id === value);
}

export function resolveVideoModelId(value: string | undefined): SupportedVideoModelId {
  if (!value) return DEFAULT_VIDEO_MODEL;
  return isSupportedVideoModelId(value) ? value : DEFAULT_VIDEO_MODEL;
}

export function videoModelSupportsImageInput(value: SupportedVideoModelId): boolean {
  return OPENROUTER_VIDEO_MODELS.find((model) => model.id === value)?.supportsImageInput ?? false;
}
