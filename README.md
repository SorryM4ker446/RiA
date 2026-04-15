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
