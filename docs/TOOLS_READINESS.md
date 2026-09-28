# TOOLS_READINESS

Updated: 2026-04-25

## 1. Summary

- `searchKnowledge`: 8/10 (usable, with a separate knowledge-base management entry; the weak points are retrieval-quality evaluation and document indexing)
- `createTask`: 8/10 (create, query, status transitions, delete and a closed loop in the side panel; reminders and due handling are still P1)
- `webSearch`: 8/10 (Tavily, automatic and manual invocation, LLM synthesis and collapsible sources; caching and retry are still P1)

## 2. Readiness checklist

| Module | Item | State | Definition of done | Priority |
|---|---|---|---|---|
| searchKnowledge | Tool registered and callable by the model | done | Triggers reliably in chat mode and returns a structured result | P0 |
| searchKnowledge | Manual entry point (`/api/tools/run`) | done | A manual call returns `data + assistantText` | P0 |
| searchKnowledge | Tightened automatic trigger gating | done | Only fires on an explicit action intent with high confidence | P0 |
| searchKnowledge | Data sources (`memories + builtin`) | done | Results distinguish `source` and `score` | P0 |
| searchKnowledge | Explainable results in the UI | done | A source label plus expandable tool detail | P0 |
| searchKnowledge | Knowledge management entry (add, view, delete) | done | A separate `/knowledge` page plus `GET/POST/DELETE /api/knowledge` | P0 |
| searchKnowledge | Retrieval quality assurance (evaluation, ranking) | missing | A minimal evaluation set, a ranking strategy and a regression baseline | P1 |
| searchKnowledge | Project documents, not only memories | partial | Documents can be indexed, updated and retrieved | P1 |
| createTask | Tool registered and writes to `tasks` | done | A created task is queryable in the database | P0 |
| createTask | Manual and automatic triggers | done | Both work in chat mode | P0 |
| createTask | Task query API (list, detail) | done | `GET /api/tasks` and `GET /api/tasks/[id]`, scoped to the workspace | P0 |
| createTask | Task mutation API (update, delete, status) | done | `PATCH/DELETE /api/tasks/[id]` with `todo/in_progress/done` plus delete | P0 |
| createTask | Task management UI (list, filter, transitions) | done | A panel in the chat page with filtering, transitions, delete and collapse | P0 |
| createTask | Time and repeat validation (due date, dedupe) | partial | Correct time zones and no duplicates for the same content | P1 |
| createTask | Closed loop (reminders, due handling) | done | Desktop due notifications and repeat rules | P1 |
| webSearch | Tool definition and input schema | done | `{ query, maxResults }` and a normalised `title/url/snippet/score/source` output | P0 |
| webSearch | Real search execution | done | A Tavily provider returning real `title/url/snippet` results | P0 |
| webSearch | Registered with the tool bus | done | Callable by the automatic and manual flows | P0 |
| webSearch | Manual entry point (`/api/tools/run`) | done | Triggerable like the other tools, with LLM synthesis | P0 |
| webSearch | Automatic trigger strategy | done (basic) | Fires when the request clearly needs external, current or online information | P1 |
| webSearch | Traceable citations | done | A collapsible list of sources under the answer | P0 |
| webSearch | Quota, timeout, retry, cache | partial | Timeouts and error codes exist; retry and caching do not | P1 |
| Common | Tools available in chat mode only | done | No manual or passive tool use outside chat mode | P0 |
| Common | Historical tool detail can be reviewed | done | Stored messages can expand to show input and output | P0 |
| Common | UI regression and server integration tests | done | Playwright mocked-UI flows and real route-handler plus SQLite tests, in layers; this is not the same as a full browser-to-database path | P0 |
| Common | Monitoring and audit log for tool calls | done (basic) | Records `toolId/trigger/state/durationMs/errorCode/requestId` | P1 |
| Common | Execution records | done | Each turn that used tools has a run with steps, states, an output summary and artifacts | P1 |
| Common | Graceful degradation when a tool is unavailable | done | An unconfigured optional tool is not offered to the model and the turn says so | P1 |

## 3. P0 schedule (usable first)

### Week 1 (2026-04-23 to 2026-04-29)

- [x] `webSearch` wired to a real search provider (Tavily, with a normalised result shape)
- [x] `webSearch` registered with the tool bus (automatic and manual)
- [x] `webSearch` citations shown under the answer (URL/source, expandable)
- [x] `webSearch` manual invocation supports search results plus LLM synthesis
- [x] `createTask`: list and detail APIs

**Acceptance:**
- [x] `webSearch` can be called manually and automatically in chat mode and returns clickable sources
- [x] A task created by `createTask` is visible through the API in the same task list

### Week 2 (2026-04-30 to 2026-05-06)

- [x] `createTask`: update, delete and status APIs
- [x] Task management UI in the side panel (list, filter, transitions, delete, show three and expand)
- [x] `searchKnowledge`: knowledge entry management API (add, view, delete)
- [x] A separate knowledge page at `/knowledge`

**Acceptance:**
- [x] A task moves from `todo` to `done` and can be deleted
- [x] Knowledge entries can be managed through the API and are found by `searchKnowledge`

### Week 3 (2026-05-07 to 2026-05-13)

- [x] End-to-end coverage for all three tools
- [x] A shared error code and log shape

**Acceptance:**
- [x] At least two stable E2E cases (three today)
- [x] Key failure cases produce a clear message (quota, timeout, permission, upstream failure)

### P0 completion record (2026-04-25)

- Tavily web search, tool-bus registration, automatic and manual triggering, LLM synthesis and collapsible sources are done.
- The task API and the side task panel are done, with optimistic status updates to reduce flicker.
- The separate knowledge management page `/knowledge` is done, linked from the chat page.
- The shared API error shape and basic tool execution log are done.
- Playwright E2E is done for `webSearch` sources, `createTask` transitions and `searchKnowledge` retrieval.

## 4. P1 schedule (quality)

### Week 4 (2026-05-14 to 2026-05-20)

- A retrieval evaluation set for `searchKnowledge` and ranking improvements
- Time zone and duplicate-task handling for `createTask`
- Trigger gating improvements for `webSearch` to reduce false triggers

### Week 5 (2026-05-21 to 2026-05-27)

- Caching, quota and retry for `webSearch`
- A general audit log across the tool call lifecycle
- Design and a minimal implementation of task reminders and due handling

## 5. Release gates (suggested)

- P0 close criteria:
  - All three tools trigger reliably in chat mode and show traceable results
  - `createTask` has a minimal management loop (add, query, update, delete plus transitions)
  - `webSearch` performs a real search and shows citations
  - Key paths pass E2E

- P1 close criteria:
  - Retrieval quality and false-trigger rate have a measured baseline
  - Runtime logs are usable for tracing and replay
  - Performance and failure-recovery behaviour is stable

## 6. Delivered beyond this plan

- Deleting a single message from a history conversation (user and assistant), editing and retrying. An edited message is confirmed and re-answered as a new turn; retry re-answers the current content.
- Context handling, with retrieval over stored documents and memories.
