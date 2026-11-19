# Sub-agents

RiA hands work to sub-agents of two kinds. They share one runner underneath
(`src/lib/agents/`): the model a call runs on, one deadline across its attempts,
the caller's stop, and cost recording. Their contracts are opposite.

| | Internal sub-agents | Task sub-agents |
| --- | --- | --- |
| Started by | RiA itself, around a turn | The model, with the `runSubagent` tool, when it judges the work suits one; the composer does not offer it |
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

As in Claude Code, the tool's description also tells the model that the brief should say
whether the sub-agent may change anything or only look, and that the report comes back to
the model rather than the user (who sees it only by opening the run record), so the answer
has to say what it found. The checklist stays the main model's: a sub-agent cannot see or
update it, the step is marked in progress before handing it off and updated when the report
comes back, and work handed to several sub-agents at once is one step.

- **Fresh context.** The sub-agent starts with its instructions (including the
  current date and time) and the brief, nothing else. Its context is compacted like
  the main conversation's when it grows, through the internal sub-agent, and those
  summaries draw on the turn's allowance of summary calls, shared with the main
  answer and any other sub-agents of the turn.
- **Tools.** The conversation's tools, within its assistant template, except
  `askUser`, `createTask`, `readWorkspaceActivity`, `updatePlan`, `extractMemory`,
  `readConversationHistory`, `generateImage` (a picture belongs in the conversation the user reads),
  `runSubagent` itself and `checkSubagents`. Extension tools loaded on demand
  work as in the main conversation.
- **Approval.** What runs follows the conversation's approval rule (see
  [terminal tools](terminal-tools.md#approval-rules)). An action the rule would ask
  the user about is **not run**: the sub-agent is told so and carries on, and its
  report lists it, so the main conversation can do it where the user approves as
  usual. Under Auto, the review sees the user's own messages from the conversation,
  never the brief: the brief is the model's text and cannot authorize anything. The
  same holds for every tool that checks what the user asked for.
- **No step cap.** As for the main turn, it runs until the work is done; stopping
  any turn of the conversation stops every sub-agent of the conversation, foreground
  and background, also when the stop comes while that turn is still starting. Its commands are attended when the turn
  is (a person can stop it), so they get no unattended time limit; a sub-agent in a
  scheduled task's turn gets that limit, as the task's own commands do.
- **Result.** `{ id, title, status, report, notRun, toolCalls }`; `status` is `failed`
  with `error` when the provider fails, which the main answer can report, and `stopped`
  when the user stopped it from its card (the turn then carries on without the report).
- **Records and cost.** Its tool calls are steps of the turn's run, recorded under
  the call that started it (`agent_steps.parentToolCallId`); the execution record
  shows them inside the sub-agent's entry, with its report and the actions it did not
  run. Its model calls appear in usage under **Sub-agents** and are added to the
  turn's cost.

## Foreground and background

By default the step that calls `runSubagent` waits for the report. With `background: true`
the call answers at once with the sub-agent's `id` and the turn goes on, as Claude Code's
`run_in_background` does. The tool's description says which suits what: waiting when the
result is needed to go on, the background when there is other work meanwhile or the user
should not wait.

Whether to start one is the model's judgement, not a keyword match. The description gives
the test (work that can be written up as a brief, and is either heavy enough to crowd the
model's context or something the user wants done apart: split up, side by side, out of the
way) with worked examples of both kinds, in the manner of the checklist tool. A user who wants
work handed off is understood without saying "sub-agent"; a user asking what sub-agents are
is answered, not handed a sub-agent. The real-model eval scores both
(`subagent-by-intent`, `subagent-question-is-not-a-request`).

Every sub-agent has a record in `subagent_runs` (status, report, actions not run, whether
the model has been given the report), kept by the registry in `src/lib/agents/subagents.ts`.
A background report reaches the model by itself, once:

- **During the turn.** Before each step, reports of background sub-agents that have
  ended are taken and sent as an automatic notice, marked as not coming from the user;
  the turn keeps it for its remaining steps. A later turn reads it again with
  `checkSubagents`, by id; it is not written into the conversation's history.
- **After the turn.** A report that ends while the conversation is idle wakes it
  (`src/lib/agents/subagent-continuation.ts`): a turn starts whose message is that
  notice, saved with a `notice` marker so the conversation shows a line ("sub-agent X
  ended; RiA carries on") rather than a message from the user. A report that comes
  while a turn runs is taken by its next step, or wakes the conversation when that turn
  ends. Nothing is woken while the conversation waits for an approval (the report goes
  with the next request), after a turn the user stopped, or for a sub-agent that was
  stopped or interrupted; those are told at the next chance. A woken turn ends with the
  usual completion alert; in a task's conversation it runs as the task's would.
- **On demand.** `checkSubagents` lists the conversation's sub-agents with their status,
  run time and current tool, and with an id gives one report. The model need not poll.

A sub-agent still marked running when the service starts again was cut off by the restart:
it reads as **interrupted** and is not run again. A task's run counts as done only once its
background sub-agents have ended and the turns their reports woke have answered; stopping
the task stops them.

In the conversation each sub-agent is a card in the answer that started it: the title, a
**Background** tag, how long it has run and which tool it is using, a stop of its own, and
its report folded under it once it ends. The card follows the service's `subagent` events
on `/api/conversations/events`; `GET /api/conversations/[id]/subagents` lists them and
`POST /api/conversations/[id]/subagents/[subagentId]/stop` stops one.

## Testing

`tests/server/subagents.test.ts` covers the tools offered, actions not run under Ask
and run under Full access, nesting and cost, parallel runs, stopping, provider
failures, the internal runner's fallback and deadline, the unattended time limit
only in scheduled turns, summaries counted against the turn's allowance, and in the
background: the id handed back at once with the report joining the next step, a late
report waking the conversation with a notice, stopping one from its card and all of
them with a turn, interrupted ones after a restart, and a task waiting for them.
`tests/e2e/subagents.spec.ts` checks the card, the execution record and the background
flow through the offline model (`OFFLINE_SUBAGENT`, `OFFLINE_SUBAGENT_BG`), and that a
notice shows as a line.
