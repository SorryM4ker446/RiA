# Model context capacity and task compaction

The model library retains each provider's reported context window and maximum
output size. OpenRouter's top-provider context is respected when it is smaller
than the model-wide window; DeepSeek supplies `context_window` and
`max_output_tokens`. Refresh the catalog and re-add an existing model to update
its saved capability metadata. Old catalog and library entries remain readable.
Saving the new settings or model metadata adds fields that older builds with
strict preference schemas may reject. Keep an upgrade-time workspace backup if
you need to downgrade; no SQL migration is required by this feature.

In **Models → Defaults and call settings → Context capacity and compaction**,
each chat model can have a context window and output limit. Empty fields use
automatic values. Configured limits cannot increase a known catalog limit.
When capacity is unknown, the application uses a labelled 131,072-token planning
ceiling; this does not establish the provider's actual capacity. Configure it
from provider documentation before relying on large requests.

## Request budgets

Input budget is context capacity minus output reservation and a 5% safety margin.
The automatic output reservation is at most 8,192 tokens and at most a quarter
of the context window. Explicit output settings still respect catalog output
limits and leave input and safety space. The output cap is sent to the provider.

Counting currently uses a conservative UTF-8 byte estimate with request framing,
including system instructions, tool JSON schemas, messages, summaries, retrieval
evidence and materialized attachments. Binary attachments are also counted.
This is an estimate, not a provider tokenizer or billing count. Large images and
scripts can therefore reach the local planning ceiling earlier than the actual
provider limit. Provider-added hidden context cannot be counted locally.

Every chat model step checks its budget, including steps after terminal or other
tool results. Before a pending approval is claimed or executed, the complete
initial context is checked. The provider middleware checks every actual request
again, including summaries and attempts to use a smaller fallback model.
Capacity refusals do not automatically retry or replay tool calls.

At roughly 75% of the input budget, completed older interactions are folded into
a task handoff, targeting approximately 50% usage when the retained input allows
it. The latest user request, the preceding user/assistant interaction, newest
tool interaction, and pending protocol parts are retained. Packed tool histories
can fold completed calls by exact identity while preserving a pending approval.
An input that still cannot fit produces `CONTEXT_LIMIT`, not a generic invalid
request-body error. Initial refusals return HTTP 413; refusals during a stream
appear as a stream error and end the run with its saved partial evidence.

## Task state and recovery

Task handoffs retain the goal and constraints, confirmed findings and evidence,
changes, actual verification results, unverified hypotheses, pending work and
running commands or approvals. Instructions explicitly distinguish planned work
from completed work and failed tests from passing tests. Summaries follow the
conversation language independently of the interface language.

During a tool loop, the handoff belongs to that stream. Full response messages
and tool records are still persisted. Between requests, the existing chat
summary fields retain task state together with the covered message and history
revision. Only new evidence is folded into a current task-state summary. When a
browser page omits intervening messages, those messages are read from storage.
Older summary formats remain readable; extending their coverage carries their
valid state forward while rebuilding from stored evidence. Concurrent history
edits or newer summary coverage prevent an obsolete write from winning.

Summarizer requests are themselves batched and bounded. Their output is capped
at 2,048 tokens and they use existing background call and cost controls. Failure,
timeout, incomplete output or an exhausted background allowance can leave
explicitly incomplete excerpts in place. Original records remain intact. Tool
execution details record compaction counts and indicate excerpt fallback after
reload. Cancellation prevents the next model request and summary write; already
completed filesystem side effects are not rolled back. Output token exhaustion
marks an execution failed with `output-limit` rather than declaring it complete.

## Remaining limits

- Summary text is model-generated and lossy; correct token budgeting cannot
  guarantee coding quality or prevent every forgotten detail.
- This does not add repeat-action detection or a default aggregate time, cost,
  failure or step ceiling. New tool runs and terminal commands still rely on
  manual cancellation, permissions and configured controls for those limits.
- Terminal capture is still bounded to 64 KiB. Compaction cannot recover lost
  output. Durable full-log artifacts and paged log reading are separate work.
- The latest mandatory input, active reasoning or approved command may exceed a
  small model's budget. Such requests are refused without shortening the command.
- A process or service restart interrupts active work; it does not automatically
  resume a terminal command or replay a write. Persisted messages can be used in
  a new request with current permissions and applicable approvals.

Automated code-task coverage runs a temporary multi-file Node project through a
real terminal: inspect, failing tests, code modification, passing tests, repeated
compaction and a reloaded follow-up. Model decisions and summaries in these tests
are deterministic fixtures; these checks validate execution and context contracts,
not the problem-solving quality of a real remote model.
