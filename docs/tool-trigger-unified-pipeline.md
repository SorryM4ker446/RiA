# Tool Trigger Unified Pipeline

## Core Rule

Direct tool calls and model tool calls share the descriptor and executor.

- `manual`: the composer calls `/api/tools/run` for a descriptor marked `surface.user.run: "direct"`, such as document conversion.
- `auto`: the model calls a tool in a conversation. This also covers a user selecting a tool or Skill in the slash menu when the model is needed to prepare or use it.

The descriptor's surface determines where the tool can run. The trigger records which execution entry point started the call.

## Required Pipeline

Both entry points use `executeRegisteredTool` in `src/tools/execution.ts`.

1. Validate the initial input against the descriptor's schema and check the tool's availability.
2. Check the active directory grant for workspace tools, apply the descriptor's optional input preparation and validate the prepared input.
3. Apply the applicable result budget and admission checks, and use the conversation's approval rule for tools that declare an action.
4. Execute the tool and record its outcome. The route returns the structured result, and the conversation can apply the descriptor's model-facing output policy.

The descriptor owns its input schema, preparation, execution and model-facing output. The shared executor enforces common rules. [Tool readiness](tool-readiness.md) · [Approval rules](terminal-tools.md#approval-rules)

## Why This Matters

Keeping calls on one pipeline gives each tool the same schema, preparation and security checks wherever it is available. A model-selected tool uses the same policy when a user requests it from the slash menu.

Shared preparation also makes later changes easier to reason about:

- Parameter defaults and model planning are updated once.
- Result budgets and caps are enforced consistently.
- Errors and logs stay comparable across trigger sources.
- UI behavior matches backend behavior more reliably.

## Implementation Notes

- `trigger` is context metadata, not a branching point for core tool behavior.
- Branch on `trigger` only when the difference is intentionally user-facing or operational, such as analytics labels, source badges, or manual-only UI affordances.
- Do not duplicate parameter preparation logic in API routes or UI components when the tool descriptor can own it.
- If a new tool adds `prepareInput`, verify both manual and automatic execution paths call it.

