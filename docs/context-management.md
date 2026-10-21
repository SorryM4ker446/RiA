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

Counting uses a character-class estimate with request framing, covering system
instructions, tool JSON schemas, messages, summaries, retrieval evidence and
materialized attachments. Runs of lowercase letters and spaces count a token per
four characters and runs of capitals one per two; digits, punctuation and
control characters count one each. Non-ASCII characters count half a token per
UTF-8 byte, and characters outside the Basic Multilingual Plane count four. Each
run is rounded up, so mixed-case random text such as base64 is not undercounted.
Measured against the cl100k and o200k encodings, this overestimates prose, code
and JSON by roughly 1.7-2x and Chinese by roughly 1.6x; the earlier UTF-8 byte
count overestimated them 3-5x and 3x. Binary attachments still count one token
per byte, so large images can reach the planning ceiling earlier than the actual
provider limit. This is a planning estimate, not a provider tokenizer or billing
count, and provider-added hidden context cannot be counted locally.

Within a tool loop, the input tokens the provider reports for each step calibrate
the later steps of the same stream. When the provider counts more than the
estimate, the estimate is scaled up to match and is not scaled back down within
that stream, so a model with a less efficient tokenizer compacts or refuses a
later step instead of overflowing. The scale is saved in the execution details
of a completed turn and does not carry over to later requests. The first step of
each request still relies on the estimate alone.

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

Older-turn summaries receive every stored tool call of each message, each in the
same bounded record form the in-stream compactor uses, which keeps status, exit
code, errors, diagnostics and file changes ahead of long output. Summarizer
requests are themselves batched and bounded. Their output is capped at 2,048
tokens. They run only within a chat request, are attributed as `summary` in
usage and stop with that request, and are subject to the concurrency limit; they
do not consume the daily background allowance or background cost ceilings,
which apply to scheduled work. Failure, timeout or incomplete output can leave
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
