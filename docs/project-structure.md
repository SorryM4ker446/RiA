# Project Structure (2026-04-17)

## Root

- `src/app`: Next.js App Router pages + API routes.
- `src/components/ui`: reusable UI primitives.
- `src/config`: model catalogs and resolver helpers.
- `src/db`: Prisma schema, migrations, database client.
- `src/features`: feature-specific modules and helpers.
- `src/lib`: shared infra (AI client, auth, memory/chat stores, server helpers).
- `src/prompts`: prompt templates.
- `src/tools`: tool definitions + registry for tool calling.

## Current high-traffic paths

- `src/app/chat/page.tsx`: main product UI page.
- `src/app/api/chat/route.ts`: multi-turn chat generation + persistence + tool use.
- `src/app/api/image/route.ts`: image generation endpoint.
- `src/app/api/video/route.ts`: video generation endpoint.
- `src/features/chat/page-utils.ts`: chat page utilities extracted from monolithic UI file.

## File organization rules

- Put feature-specific code under `src/features/<feature>/*`.
- Keep route handlers in `src/app/api/*`, but move heavy helpers into `src/features` or `src/lib`.
- Keep model IDs centralized in `src/config/model.ts`.
- Store server-only shared infrastructure in `src/lib/server/*`.
- Keep `page.tsx` focused on state + rendering; push codecs and pure helpers out.

## Recommended next refactor targets

1. Split `src/app/chat/page.tsx` into:
   - `src/features/chat/use-chat-page-state.ts`
   - `src/features/chat/message-renderer.tsx`
   - `src/features/chat/model-selector.tsx`
2. Add `src/features/chat/persistence.ts` for conversation message save/load helpers.
3. Add `src/features/chat/types.ts` for page/API shared types.
4. Add tests for message codec round-trip (image/video/user file payload persistence).
