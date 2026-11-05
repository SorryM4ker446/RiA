# Tool readiness

Updated: 2026-10-18

Chat execution details consolidate tool parameters/results, web/document
references, legacy local-file uses and retrieval diagnostics. Chat prose retains
inline citations, attachments and document downloads. Pending approvals appear
above the composer without opening the detail sheet; each terminal command still
requires human review. Linked approval continuations share one execution entry.

## Current scope

RiA has a shared tool registry and execution pipeline for built-in tools, MCP servers and HTTP connectors. The earlier three-tool checklist and fixed weekly schedule are historical; they no longer describe the delivered application. This document records implemented behavior and remaining validation, without subjective readiness scores.

Normal chat uses automatic tool selection. Typing `/` in the composer chooses a tool or skills for one message: a chosen tool is offered alone on the first step only, so it does not restrict later model calls. Each tool declares who can reach it (`surface`), and the slash menu, template editor and built-in tool list all follow that declaration. Tools only the model uses, such as the terminal and the Skill reader, never appear in the slash menu.

## Implemented capabilities

| Area | Current behavior | Boundaries and documentation |
| --- | --- | --- |
| Knowledge: `searchKnowledge` | Memories and documents, local keyword retrieval, optional semantic + BM25 retrieval, collection scope, versioned citations and quality evaluations | Candidate memories stay outside model context until confirmed. Embedding and answer-quality checks may call configured services. [Document knowledge](document-knowledge.md) |
| Memory: `extractMemory` | The model's own: a person cannot run or choose it, and it is offered only while long-term memory is on. See [long-term memory](long-term-memory.md) | Always ready while memory is on |
| Knowledge: `saveKnowledgeEntry` | Adds a named entry to the knowledge base, with provenance; a save the model requests waits for approval and never overwrites a different entry | Always ready |
| Tasks: `createTask` | Creation through chat; list/edit/status/delete management, time zones, due reminders and recurrence | The next recurring task is created on completion; desktop reminders require the application to remain running. [Task reminders](task-reminders.md) |
| Search: `webSearch` | DeepSeek native/Search API, OpenRouter gateway search through the selected chat model's provider, model-selected result counts and citations | No RiA per-turn result-count quota; provider API ceilings and run execution limits apply. Missing configuration is distinct from zero results. No general search-result cache or automatic retry is promised. [Search notes](web-search-budget-and-quality.md) |
| Documents: `readDocument`, `convertDocument` | Reads stored extracted text in bounded ranges; exports Markdown, TXT, HTML or DOCX | Knowledge document details integrate copy editing, preview and export; import supports PDF/DOCX/Markdown/TXT. Chat PDF/DOCX attachments are parsed without automatic knowledge import. [Document processing](document-processor.md) · [Chat attachments](media-storage.md#pdf-and-word-in-chat) |
| Terminal: `runTerminalCommand` | General Windows PowerShell for file management and development commands, mandatory human approval, bounded output, live status and stop controls | Separate terminal permission; fresh non-interactive process per command. No PTY, persistent shell session or OS sandbox. [Terminal](terminal-tools.md) |
| Project files: `readProjectFile`, `editProjectFile` | Line-range reads with a content hash; exact text replacement or file creation applied atomically, with the diff shown for approval | Offered wherever the terminal is and governed by the same folder permission and approval mode. UTF-8 text only; `.git` and credential files are refused. Rename, move, delete and execution stay in the terminal. [Terminal](terminal-tools.md#project-file-tools) |
| External tools | MCP Streamable HTTP, desktop stdio and HTTP connectors; detection, explicit tool selection, enablement and per-call approval | Required runtimes and accounts are configured separately; no automatic OAuth or dependency installation. [Extensions](extensions.md) |
| Skills: `readPluginSkill` | Enabled community Skills contribute an index; instructions and reference files load on demand from saved textual snapshots | Needs a tool-capable chat model. Skill installation adds no script execution or filesystem permission. [Plugin packages](plugin-packages.md) |

## Shared execution contract

- Descriptors own schemas, input preparation, execution and output policy. Built-in and external tools resolve through the same registry; chosen and model-selected calls retain the relevant shared checks. [Pipeline](tool-trigger-unified-pipeline.md)
- Availability is checked before exposing tools and again when executing. Optional missing/unavailable tools can return a controlled skip; invalid input, rejected approval and refused writes are not treated as successful fallback.
- Model tool support, assistant scope, connection state, directory grants and per-call approvals are separate requirements. Importing a plugin or viewing marketplace metadata satisfies none of these automatically.
- Runs and steps record kind, tool name, state, error code, timing and a bounded input/output summary. Step, failure, time and cost controls apply; cancellation stops subsequent work and does not undo completed effects. Interrupted writes and old approvals are not automatically replayed. [Execution records](execution-history.md)
- Disabling a plugin/connection blocks subsequent calls and invalidates approvals. Uninstall removes owned configuration while retaining unrelated connections and historical results. Portable restore keeps local declarations but disables them. [Persistence](plugin-packages.md#persistence-and-api)

## Discovery and installation

**Settings → Extensions → Discover extensions** searches the official MCP Registry and opens connection drafts. Results scroll in a bounded panel with cursor loading. Users still configure credentials, detect tools, select and enable them.

**Settings → Extensions → Plugin marketplace → Discover skills** searches skills.sh, previews supported snapshots and installs disabled packages. RiA packages can also combine Skill instructions with MCP/HTTP configuration through validated `.ria-plugin.json` imports. Browsing and installation do not execute business tools.

Arbitrary Claude/DSH plugin runtimes, executable Skill scripts, automatic plugin updates/rollback and generalized external-runtime installation remain unsupported. Market discovery is not compatibility certification.

## Verification and remaining acceptance

The repository includes contract, server/SQLite, browser and desktop coverage for these paths. Relevant suites include:

| Contract | Regression coverage |
| --- | --- |
| Shared tools, schemas and route behavior | `tests/server/tool-contracts.test.ts`, `tests/server/tool-http.test.ts` |
| Documents and attachments | `tests/server/document-processor.test.ts`, `tests/e2e/document-processor.spec.ts`, `tests/e2e/chat-documents.spec.ts` |
| Connectors and Registry discovery | `tests/server/extensions.test.ts`, `tests/server/extension-registry.test.ts`, `tests/e2e/extensions.spec.ts`, `tests/e2e/extension-discovery.spec.ts` |
| Plugin lifecycle and Skill snapshots | `tests/server/plugin-packages.test.ts`, `tests/server/skill-marketplace.test.ts`, `tests/e2e/plugin-packages.spec.ts`, `tests/e2e/skill-marketplace.spec.ts` |
| Terminal approvals and process lifecycle | `tests/server/terminal.test.ts`, `tests/desktop/terminal-migration.test.ts`, `tests/e2e/terminal.spec.ts` |

These files document coverage, not a claim that every suite was rerun during this documentation update. Current checks and fixture boundaries are described in [testing](testing.md). Local results must be distinguished from actual CI runs, live-service compatibility and real-model answer quality.

Before release, validate representative configured Skills/connectors with their real prerequisites, review results against real documents, and complete installation/upgrade and native behavior checks for the actual MSI. Follow [Windows release acceptance](windows-release-acceptance.md); a successful package build does not fill manual acceptance results.

## Models that cannot call tools

A chat model without tool calling loses everything built on tools: knowledge search, web
search, the terminal, file reading and editing, tasks and extension tools. Before chatting
with one, the chat page says so and asks the person to carry on or change the model. Leaving
the model menu without changing it asks again. The answer holds for that model until the app
closes. A model set by the assistant template can only be accepted here, a template with no
tools is not asked about, and image and video modes do not use tools.
