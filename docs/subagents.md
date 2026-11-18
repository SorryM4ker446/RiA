# Sub-agents

RiA hands work to sub-agents of two kinds. They share one runner underneath
(`src/lib/agents/`): the model a call runs on, one deadline across its attempts,
the caller's stop, and cost recording. Their contracts are opposite.

| | Internal sub-agents | Task sub-agents |
| --- | --- | --- |
| Started by | RiA itself, around a turn | The model, with the `runSubagent` tool |
| Work | Approval review under Auto, context and task summaries, long-term memory, planning a web search | Any self-contained piece of work the model hands off |
| Model | The internal sub-agent model, or the model the work is for | The conversation's model |
| Tools | None | The conversation's tools, with a few exceptions (below) |
| Input | Put together by RiA; conversation content cannot steer it | A brief the model writes |
| Usage source | `tool` or `summary`, as before | `agent` |

## Internal sub-agents

**Models → Defaults and call settings → Internal sub-agent model** picks the chat
model for this work; unset, the model the work is for does it (stored as
`auxiliary` in the preferences, as before). Each call runs on the chosen model and,
if that fails, once on the model the work is for, within one deadline: a fallback
gets no fresh time. Summaries keep no deadline of their own (their calls are bounded
by size) and are not retried once a turn has no summary calls left. Their
instructions are fixed and they get no tools, so text in a page, file or tool result
cannot make them do anything.

## Task sub-agents

The model calls `runSubagent` with a short `title` and a `task`: the complete brief,
since the sub-agent sees nothing of the conversation. It suits work that takes many
steps or much reading whose details the main answer does not need: researching
across many documents or pages, examining a large folder, trying several approaches.
Several calls in one step run at the same time, with no fixed limit.

- **Fresh context.** The sub-agent starts with its instructions (including the
  current date and time) and the brief, nothing else. Its context is compacted like
  the main conversation's when it grows, through the internal sub-agent, and those
  summaries draw on the turn's allowance of summary calls, shared with the main
  answer and any other sub-agents of the turn.
- **Tools.** The conversation's tools, within its assistant template, except
  `askUser`, `createTask`, `readWorkspaceActivity`, `updatePlan`, `extractMemory`,
  `readConversationHistory` and `runSubagent` itself. Extension tools loaded on demand
  work as in the main conversation.
- **Approval.** What runs follows the conversation's approval rule (see
  [terminal tools](terminal-tools.md#approval-rules)). An action the rule would ask
  the user about is **not run**: the sub-agent is told so and carries on, and its
  report lists it, so the main conversation can do it where the user approves as
  usual. Under Auto, the review sees the user's own messages from the conversation,
  never the brief: the brief is the model's text and cannot authorize anything. The
  same holds for every tool that checks what the user asked for.
- **No step cap.** As for the main turn, it runs until the work is done; stopping
  the turn stops every sub-agent it started. Its commands are attended when the turn
  is (a person can stop it), so they get no unattended time limit; a sub-agent in a
  scheduled task's turn gets that limit, as the task's own commands do.
- **Result.** `{ title, status, report, notRun, toolCalls }`; `status` is `failed`
  with `error` when the provider fails, which the main answer can report.
- **Records and cost.** Its tool calls are steps of the turn's run, recorded under
  the call that started it (`agent_steps.parentToolCallId`); the execution record
  shows them inside the sub-agent's entry, with its report and the actions it did not
  run. Its model calls appear in usage under **Sub-agents** and are added to the
  turn's cost.

## Testing

`tests/server/subagents.test.ts` covers the tools offered, actions not run under Ask
and run under Full access, nesting and cost, parallel runs, stopping, provider
failures, the internal runner's fallback and deadline, the unattended time limit
only in scheduled turns, and summaries counted against the turn's allowance. `tests/e2e/subagents.spec.ts`
checks the execution record through the offline model (`OFFLINE_SUBAGENT`).
