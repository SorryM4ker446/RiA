# Tool Trigger Unified Pipeline

## Core Rule

Manual tool calls and automatic semantic tool calls are the same tool capability with different trigger sources.

- `manual`: the user explicitly selects a tool and runs it.
- `auto`: the system decides from the user request that a tool should be used.

The trigger records how the tool call started. It must not create a separate business path for the tool.

## Required Pipeline

After a tool is selected, both trigger sources should use the same descriptor-driven pipeline:

1. Build the raw tool input.
2. Run `descriptor.prepareInput` when the tool defines it.
3. Validate the prepared input with the tool schema.
4. Apply shared budget and safety limits.
5. Execute the tool.
6. Build assistant-facing text from the tool output.
7. Record logs and memory according to the shared tool policy.

The tool descriptor should stay the single source of truth for parameter preparation, validation, execution, result rendering, and persistence policy.

## Why This Matters

Keeping manual and automatic calls on one pipeline prevents behavior drift. For example, a web search triggered automatically should not use model-planned parameters while a manual web search silently falls back to internal defaults.

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

