# Features

Feature-oriented modules live here. Keep UI helpers, codecs, domain types, and orchestration
logic together to avoid overloading route/page files.

## Current modules

- `chat/page-utils.ts`: shared utils for `/chat` page (prompts, message codecs, file handling).

## Suggested module growth

- `chat/api-client.ts`: browser-side request helpers (`/api/image`, `/api/video`, persistence POSTs).
- `chat/use-chat-state.ts`: local state and effects for model mode, drafts, attachments.
- `chat/renderers.tsx`: message content renderers (text/image/video/tool blocks).
