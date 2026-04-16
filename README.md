# Private AI Assistant Skeleton

Tech stack:
- Next.js App Router + TypeScript
- Vercel AI SDK
- PostgreSQL + Prisma
- Tailwind CSS + shadcn/ui

## Quick start

```bash
npm install
cp .env.example .env
npm run db:generate
npm run dev
```

## Directory highlights

- `src/app`: pages + route handlers
- `src/components`: reusable UI and view components
- `src/features`: business capabilities (chat, memory, rag, tools)
- `src/lib`: shared infrastructure code
- `src/db`: Prisma schema and DB client
- `src/prompts`: prompt assets
- `src/tools`: tool definitions and registry

Detailed layout and refactor guidance:
- `docs/project-structure.md`

## OpenRouter model presets

Preset file: `src/config/model.ts`

Chat model presets (aligned with OpenRouter rankings, synced on 2026-04-16):
- `anthropic/claude-opus-4.6`
- `anthropic/claude-sonnet-4.6`
- `deepseek/deepseek-v3.2`
- `minimax/minimax-m2.7`
- `minimax/minimax-m2.5`
- `google/gemini-3-flash-preview`
- `xiaomi/mimo-v2-pro`
- `nvidia/nemotron-3-super-120b-a12b:free`
- `google/gemini-2.5-flash`
- `google/gemini-2.5-flash-lite`

Image model presets (aligned with OpenRouter image-model rankings page):
- `google/gemini-2.5-flash-image`
- `google/gemini-3.1-flash-image-preview`
- `google/gemini-3-pro-image-preview`
- `bytedance-seed/seedream-4.5`
- `openai/gpt-5-image-mini`
- `openai/gpt-5-image`

## How to manually add models

### Add a chat model

1. Edit `src/config/model.ts`, append an item in `OPENROUTER_MODELS`:

```ts
{
  id: "provider/model-id",
  label: "Your Model Name",
  description: "Short note",
}
```

2. No extra UI wiring needed: chat selector uses `OPENROUTER_MODELS` automatically.
3. Start dev server and verify:

```bash
npm run dev
```

### Add a text-to-image model

1. Edit `src/config/model.ts`, append the model in `OPENROUTER_IMAGE_MODELS`.
2. Use `getImageModel(...)` from `src/lib/ai/client.ts` with `generateImage` from `ai`.
3. Return base64 data URL to frontend for preview.

Minimal API route example (`src/app/api/image/route.ts`):

```ts
import { generateImage } from "ai";
import { NextRequest } from "next/server";
import { resolveImageModelId } from "@/config/model";
import { getImageModel } from "@/lib/ai/client";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    prompt?: string;
    modelId?: string;
    size?: `${number}x${number}`;
  };

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  const modelId = resolveImageModelId(body.modelId);
  const result = await generateImage({
    model: getImageModel(modelId),
    prompt,
    n: 1,
    size: body.size ?? "1024x1024",
  });

  const image = result.image;
  const dataUrl = `data:${image.mediaType};base64,${image.base64}`;

  return Response.json({ modelId, dataUrl });
}
```
