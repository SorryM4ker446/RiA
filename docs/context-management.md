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

## Prompt layout

The system prompt holds only rules that stay the same across a conversation's
turns: the base instructions, tool rules, capability status, user preferences,
the assistant template and the skill index. Each rule is stated once. This turn's
reference data — the summary of earlier turns (or, when no summary covers them,
labelled excerpts), matching memories and automatically added knowledge evidence
— is sent as one labelled context block at the start of the latest user message.
The block is rebuilt for every request and never saved with the message. Earlier
turns are sent unchanged, so providers with prefix caching can reuse everything
up to the previous turn instead of missing the cache on every request.

### Prompt caching

OpenAI, DeepSeek and Gemini models cache a repeated prompt prefix on their own.
Anthropic models only reuse a prefix up to an explicit breakpoint, so chat
requests to an `anthropic/` model through OpenRouter mark three: the end of the
system prompt, the end of the previous turn and the end of the request, which
the next step of a tool loop extends. Generated one-off calls such as summaries
are not marked, since a cache write costs more than ordinary input and they
would not read it back. Usage records do not store cache read or write counts;
the cost a provider reports already reflects its cache discount.

## Request budgets

Input budget is context capacity minus output reservation and a safety margin of
5% of the window, at most 32,768 tokens.
The automatic output reservation is at most 8,192 tokens and at most a quarter
of the context window. The reservation only sizes the input budget; it is not
the cap sent to the provider. Each call is capped by the known output limit — the
configured value, else the catalog value, never above the catalog — reduced only
as far as that call's estimated input requires to stay within the window, and
never below the reservation. When neither a configured nor a catalog output
limit is known, a default of 131,072 tokens (128K, the per-call maximum of
current frontier models) is used the same way, for any provider and model. A
model whose real output limit is lower must have it configured, or the provider
rejects the call. An internal call that asks for a smaller cap keeps it. The one
exception is a scheduled background call while a background monetary ceiling is
enabled: with no known limit, it is bounded by the reservation so it is not
priced as a 128K-token answer.

Counting uses a character-class estimate with request framing, covering system
instructions, tool JSON schemas, messages, summaries, retrieval evidence and
materialized attachments. Runs of lowercase letters and spaces count a token per
four characters and runs of capitals one per two; digits, punctuation and
control characters count one each. Non-ASCII characters count half a token per
UTF-8 byte, and characters outside the Basic Multilingual Plane count four. Each
run is rounded up, so mixed-case random text such as base64 is not undercounted.
Measured against the cl100k and o200k encodings, this overestimates prose, code
and JSON by roughly 1.7-2x and Chinese by roughly 1.6x; the earlier UTF-8 byte
count overestimated them 3-5x and 3x. Images (PNG, JPEG, GIF, WebP) are counted
from their dimensions: scaled to a long edge of at most 2048 pixels, as common
providers resize them, at one token per 750 pixels and never more than their
byte size. A 4000x3000 photo therefore counts about 4,200 tokens instead of its
millions of bytes. Other binary attachments still count one token per byte.
This is a planning estimate, not a provider tokenizer or billing
count, and provider-added hidden context cannot be counted locally.

Within a tool loop, a step is measured from provider usage when it can be: while
nothing has been folded since the previous step, its size is the input tokens the
provider reported for that step plus the calibrated estimate of the messages
appended after it. The ratio the provider reports also calibrates the remaining
estimates of the stream; it is raised to match a provider that counts more and
is not lowered again within that stream, so a model with a less efficient
tokenizer compacts or refuses a later step instead of overflowing. The scale is
saved in the execution details, including for turns that end in an error.

Each turn also records its largest provider-to-estimate ratio for the model. The
largest of the model's last 20 recorded ratios scales the first step of later
requests, the history window and summary batching. It can fall below one, since
the local count deliberately overestimates, but never below 0.5, the documented
bound of that overestimate; without recorded ratios the estimate is used
unscaled. The heaviest recent content sets the scale, and an outlier ages out.
This per-model calibration is a planning cache in its own table: it is not backed
up, and missing or unreadable data falls back to the uncalibrated estimate.

The history is the stored conversation, not only what the browser has loaded:
turns before the browser's first message are read from storage, starting at the
last message the current summary covers. Earlier turns of the conversation may
use half the input budget, measured in the same estimated tokens. Turns beyond that window are covered by the conversation
summary and labelled excerpts; the per-step check then compacts within the
request as needed. The window starts right after the last message the current
summary covers for as long as the turns after it fit. Only when they no longer
fit are older turns dropped, down to 60% of the window, and the summary extended
to the new start. The start therefore holds for many turns: the summary is
reused instead of being regenerated before every answer, and the prompt prefix
stays the same, so provider prompt caches keep matching it. When no summary
covers the older turns, their excerpts grow with the window: at least 4,000
characters, otherwise an eighth of the window's estimated tokens.

Every chat model step checks its budget, including steps after terminal or other
tool results. Before a pending approval is claimed or executed, the complete
initial context is checked. The provider middleware checks every actual request
again, including summaries and attempts to use a smaller fallback model; as the
callers measure more precisely, it refuses only input that cannot fit even at the
lowest calibration, and sizes the output cap from the learned one.
Capacity refusals do not automatically retry or replay tool calls.

At 90% of the input budget, completed older interactions are folded into
a task handoff, targeting approximately 60% usage when the retained input allows
it. The latest user request, the preceding user/assistant interaction, newest
tool interaction, and pending protocol parts are retained. Packed tool histories
can fold completed calls by exact identity while preserving a pending approval.
An input that still cannot fit produces `CONTEXT_LIMIT`, not a generic invalid
request-body error. Initial refusals return HTTP 413; refusals during a stream
appear as a stream error and end the run with its saved partial evidence.

When the provider itself refuses a chat step because its input exceeds the
model's window, the local count was too low. The step's calibration is raised
(by at least 1.25x and at most 2x), the usage anchor is dropped, every completed
interaction is folded as above, and the step is sent once more. A second refusal
of the same step, or an input that still cannot fit, ends the run as before.
Recognised refusals are a 400 or 413 whose wording names the context length or
window, or an OpenAI-style `context_length_exceeded` code; the DeepSeek adapter
classifies its own refusal body and keeps only that flag, never the text. The
execution details count these recoveries.

### Compaction tool

Chats also offer the built-in `compactContext` tool, including assistants with a
restricted tool list: it grants no external capability. The model may call it
when a phase of work is finished and its tool output is no longer needed
verbatim, optionally naming a `focus` the handoff must keep. The fold itself runs
in the per-step planner before the next step, through the same summarizer,
compaction-call allowance and retention rules, but folds every completed
interaction instead of stopping at the target. Each call is acted on once. It is
not a manual tool, since it acts on a running chat.

### Usage indicator

Beside **Automatic tools** in the composer, a small ring and percentage show how much of
the model's window the conversation's latest request used, from its saved
execution details. It stays muted until usage nears the compaction trigger;
hovering shows the token counts, the trigger and how often that request was
compacted. Conversations without saved details, and image or video modes, show
nothing.

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
requests are themselves batched and bounded. Summary room follows the model's
window: the requested handoff length is a thirty-second of the context window,
between 2,048 and 8,192 tokens and never above the model's output limit. It is
enforced by the stored state budget rather than by an output cap, so reasoning
does not cut a handoff short; summary calls follow the chat output rule above.
Each batch may use a
quarter of the input budget, between 24,000 and 128,000 tokens. The timeout is
60 seconds per 2,048 output tokens. A request may make at most **Compaction calls per request**
summary calls (default 20, in model call limits), shared by older-turn summaries
and in-stream compaction; once used up, compaction keeps labelled excerpts, the
request continues and its execution details state that the limit was reached.
They run only within a chat request, are attributed as `summary` in
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
- Terminal output beyond the capture is recoverable only while its log exists:
  logs expire after seven days, are bounded in size and require the folder's
  terminal access. See [terminal tools](terminal-tools.md).
- Estimates are calibrated from provider-reported usage, which providers may omit;
  without it the first step relies on the character-class estimate alone.
- Recovery from a provider's window refusal covers chat steps. Summary, tool
  synthesis and continuation requests report such a refusal as a failure, and a
  provider whose refusal wording is not recognised is treated as any other 400.
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
