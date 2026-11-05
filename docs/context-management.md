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
reference data — excerpts of any older turns no summary covers, which files changed,
matching memories and automatically added knowledge evidence — is sent as one labelled
context block at the start of the user message it belongs to. The conversation's summary, when there is one, opens
the messages as a labelled user message, with an exact record of what was done and
the files and skills put back underneath. Earlier turns follow exactly as they were
sent: each with the context block and directive it went out with, step by step, with
its real tool calls and results, so a provider's prompt cache matches everything up to
the new message. The block is saved with its message for this, unless it is over
32,000 characters, in which case it is sent once. An approval resuming continues the
same request and sends the block it already had. A file not read back the same way, or
a turn saved before steps were recorded, simply misses the cache once.

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
estimates of the stream: the first step counted replaces the guess the stream began
with, and from there the scale only rises, so a model with a less efficient tokenizer
compacts or refuses a later step instead of overflowing. The scale, the count the
provider last reported and how it compares with the estimate are saved in the
execution details, including for turns that end in an error.

A conversation is scaled by its own latest request, since what it is written in
matters most: DeepSeek counts about 0.62 of the estimate on English with tools and
0.41 on Chinese. A conversation with no such request yet, or last answered
by another model, goes by what the model has seen: each turn records its largest
provider-to-estimate ratio, and the largest of the model's last 20 scales the first
step, the history window and summary batching. The scale can fall below one, since
the local count deliberately overestimates, but never below a third; without recorded
ratios the estimate is used unscaled. A conversation that turns heavier than its last
request is caught by the provider's count on the next step, and an underestimate the
provider refuses is recovered from as below.
This per-model calibration is a planning cache in its own table: it is not backed
up, and missing or unreadable data falls back to the uncalibrated estimate.

The history is the stored conversation, not only what the browser has loaded:
turns before the browser's first message are read from storage, starting at the
last message the current summary covers. Earlier turns of the conversation may
use everything under the compaction trigger, measured in the same estimated
tokens, and travel with their real tool calls and results, so a later turn can use
what an earlier one read. Only a very long tool input, such as a whole script, is
cut to an excerpt, and a call that never finished stays as a note, since it has no
result to pair with. DeepSeek gets the stored reasoning back with a tool turn when
there is any, and accepts one without; other providers get none. A model or assistant without tools gets every turn as text. Turns beyond the window are covered
by the conversation summary and labelled excerpts; the per-step check then compacts
within the request as needed. The window starts right after the last message the
current summary covers for as long as the turns after it fit. Only when they no
longer fit are older turns dropped, down to 30% of the window, and the summary
extended to the new start. Tool calls the summary stands in for are not sent and take
no room. The turn just before a request stays however large its tool results, as long
as what cannot be shortened fits: the per-step check shortens the results below, so
the model still knows what it just did, such as a command it ran. The start therefore holds for many turns: the summary is
reused instead of being regenerated before every answer, and the prompt prefix
stays the same, so provider prompt caches keep matching it. When no summary
covers the older turns, their excerpts grow with the window: at least 4,000
characters, otherwise an eighth of the window's estimated tokens.

A finished turn keeps the summary ahead of the limit. Once the turns after the
current summary reach 85% of the window, or sooner if another turn the size of the
latest would not fit (never below 50%), a background job folds them down to the same
tail, so the next request usually finds it ready. When what the provider counted for
the latest request, which includes the instructions and tool definitions, plus another
such turn would come within 5% of the compaction trigger, it folds whatever the window
says. If a request
still has to fold before it can start, its response starts first and tells the reader
context is being organized, and a refusal after that arrives as a stream error. After three consecutive
failures a conversation stops trying until it has grown by ten messages, so a failing
provider or a summary that never fits does not cost a call on every turn. At most one job runs per
conversation. A request never waits for one when any summary exists: it answers
from that summary plus excerpts of the gap behind it. Only a conversation with
older turns and no summary at all waits, and its response starts first, telling
the reader context is being organized; if the summary fails, the answer comes
from the excerpts. Stopping that wait closes the run, and the job carries on,
since the next request needs the same summary. A restore is refused while a job
holds a model call it will write back, and a job that exits with the process
loses nothing.

Saving a new message leaves the summary alone. Rewriting a stored message, as an
answer continuing after an approval does, advances the history revision so that
a summary still being written from the old text is refused; the stored summary
is cleared only if it does not provably end before the rewritten message.

After a fold, what the model was working with is put back once and then sent unchanged
until the next fold, so a provider's cache keeps matching it: up to the five most
recently modified of the files read or edited in the conversation's current folder,
with a file over 5,000 tokens given as a path to read again, and the skills it used, up
to 5,000 tokens each and 25,000 in all, keeping the start of each and dropping the
oldest first. All of it together stays under 15% of the input budget, so on a small
window files go back as paths. A file still in the conversation is not repeated. A fold
during a turn puts them back straight away, within the same limits; any other fold does
so at the next request.

Each request checks up to twenty files the model has seen against the hash it last saw,
and the context block names any that something else changed or removed, so it reads
them again before relying on them. Only the tool's own edits and reads update that hash.

Every chat model step checks its budget, including steps after terminal or other
tool results. Before a pending approval is claimed or executed, the complete
initial context is checked. The provider middleware checks every actual request
again, including summaries and attempts to use a smaller fallback model; as the
callers measure more precisely, it refuses only input that cannot fit even at the
lowest calibration, and sizes the output cap from the learned one.
Capacity refusals do not automatically retry or replay tool calls.

At 90% of the input budget, results of finished tool interactions are first
shortened to bounded excerpts, oldest first, until the step is back near 60%.
This takes no model call. An excerpt is a sixteenth of the input budget in characters,
between 1,600 and 24,000, so a small window keeps room to work in. A file read keeps its first and last lines and says which
lines were left out and how to read just those; other results keep both ends. Each call stays paired with its result, the newest
interaction is untouched (a turn reloaded while waiting for an approval holds all its
calls together, and then what was approved and the result read last count as newest), and a terminal result still names its full log, so the
model can read the part it needs. The same excerpts are used for the rest of the
stream, so the prompt prefix stops changing, and stored messages are unaffected.
If the step is still at 90% after that, completed older interactions are folded into
a task handoff, targeting approximately 60% usage when the retained input allows
it. While the step still fits, a fold that would free less than a fifth of the input
budget, or 32,768 tokens on a very large window, is not paid for: once results are excerpts there may be little left to free,
and the summary, which itself takes room, would cost more than it saves. The latest user request, the preceding user/assistant interaction, newest
tool interaction, and pending protocol parts are retained. Packed tool histories
can fold completed calls by exact identity while preserving a pending approval.
If a step still does not fit after folding, what was put back under the summary is dropped
and then the newest tool results are shortened to excerpts too, so the model can carry
on and read less at a time. A pending approval's input is never shortened. If a turn
folds eight times within twenty steps, what a fold frees is being used up almost at
once, usually by tool output nearly the size of the window, and the turn stops with
`CONTEXT_LIMIT` rather than spending a summary every two or three steps. An input
that still cannot fit produces `CONTEXT_LIMIT`, not a generic invalid request-body
error. Initial refusals return HTTP 413; refusals during a stream
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

`compactContext` is registered with the other tools and is never in the tool set
sent to the model: when to compact is decided from usage, and a model could not call
anything once a request is already over the limit. The application runs the fold
automatically as described above, and a person runs it by choosing **压缩上下文** in
the slash menu, optionally typing what to keep, and sending. All of them write the
conversation's one summary.

A person's request needs no model to answer and adds no message: it folds the
stored conversation up to the latest exchange and reports the result as a toast, or
says there is nothing to organize yet. It tries even when automatic folding has
paused after failures. A failure is reported and puts the choice back. The next
request's window starts after the new summary, and the usage indicator reflects the
freed space straight away.

Where the summary ends, the transcript shows a marker that opens to what it says. The
turns above it stay readable; the model now sees them as the summary.

### Auxiliary model

**Models → Defaults and call settings → Auxiliary model** picks a chat model for
work around a turn: summaries, in-stream folds and planning a web search. Unset,
the model the work is for does it. A chosen model that was removed or whose
provider has no key falls back the same way, a summary it fails to write is tried
once on the model the work is for, and removing a model from the library clears the
choice.

### Usage indicator

Beside **Automatic tools** in the composer, a small ring and percentage show how much of
the model's window the conversation's latest request used, from what the provider
counted when it said, otherwise the estimate saved in the execution details. It stays muted until usage nears the compaction trigger.
Hovering shows what the window holds: a bar, and a row with the share of the window
each for messages, tool results, the summary and what was restored, the system prompt,
built-in tools, extension tools, skills, memory and references, then the buffer kept for
compaction and the free space; pointing at a row also shows its tokens. A part the request did not use is left out. The parts are
local estimates whose proportions divide up the total, so they add up to it. Requests
saved before this show the total only. Conversations without saved details, and image or video modes, show
nothing.

## Task state and recovery

Task handoffs suit any conversation. They cover what applies of the user's goal,
preferences and constraints, every user message in their own words, confirmed facts
and decisions, work done and what it produced, errors and how they were resolved,
and what is open, including anything still running or waiting for approval. They keep exact names and numbers the conversation depends on, such as
paths, commands, exit codes and failed tests. Instructions explicitly distinguish
planned work from completed work and what was checked from what was only claimed. A
fold during a turn is told what the user asked for, since that message stays in the
conversation and so appears in no evidence; without it a summary cannot say what the
work was for.
Summaries follow the conversation language independently of the interface language.

Under the summary travels a record no model wrote: the commands run with their exit
codes and the files edited or created, the latest forty, so those survive even when the
summary leaves them out. A conversation has one summary, however it was written. A fold during a tool loop
goes straight into it, with the tool calls it stands in for, so the next request, or
this turn resuming after an approval, neither resends that work nor summarizes it
again. If the fold had to fall back to labelled excerpts, those stand in for this
turn only and the stored summary stays as it was. A provider that reuses a call
identity within the conversation keeps that call in the prompt. Full response
messages and tool records are still persisted. Between requests, the existing chat
summary fields retain task state together with the covered message and history
revision. Only new evidence is folded into a current task-state summary. When a
browser page omits intervening messages, those messages are read from storage.
Older summary formats remain readable; extending their coverage carries their
valid state forward while rebuilding from stored evidence. Concurrent history
edits or newer summary coverage prevent an obsolete write from winning.

With no auxiliary model, a summary straight after a turn or during one sends the
conversation exactly as the model just received it, with its system prompt and tool
definitions, then the writing instructions and the full results of anything shown only
as excerpts. It therefore reads the prefix from a provider's cache and works from the
real messages. Its tool definitions cannot run anything. If the conversation has a call
still waiting for a result, leaves no room, or the model replies with a tool call, the
summary is written from records instead, as it always is for a person's request and for
an auxiliary model, which have nothing cached to read.

Older-turn summaries receive every stored tool call of each message, each in the
same bounded record form the in-stream compactor uses, which keeps status, exit
code, errors, diagnostics and file changes ahead of long output. A record is up to
an eighth of the input budget in characters, between 6,000 and 24,000, so a summary
on a large model sees much more of each result, and a fold reads the results
themselves even when the model was only shown excerpts of them. Summaries reason the
way the conversation is set to: thinking turned off stays off for them too. Summarizer
requests go in one call whenever the model can hold the evidence, and are otherwise
batched. Summary room follows the model's window: the requested handoff length is a
sixteenth of the context window,
between 2,048 and 16,384 tokens and never above the model's output limit. It is
enforced by the stored state budget rather than by an output cap, so reasoning
does not cut a handoff short; summary calls follow the chat output rule above.
Each call may use the input budget less that length. The timeout is
60 seconds per 2,048 output tokens. A request may make at most **Compaction calls per request**
summary calls (default 20, in model call limits), shared by older-turn summaries
and in-stream compaction; once used up, compaction keeps labelled excerpts, the
request continues and its execution details state that the limit was reached.
They run within a chat request or in the background job after one, are attributed
as `summary` in usage and are subject to the concurrency limit; those within a
request stop with it, and they
do not consume the daily background allowance or background cost ceilings,
which apply to scheduled work. Failure, timeout or incomplete output can leave
explicitly incomplete excerpts in place. Original records remain intact, and the model can look them
up: `readConversationHistory` finds text in this conversation's saved messages and tool
results and reads one by the `toolCallId` or message id it was shown, a page of 20,000
characters at a time. It is the model's alone: a person cannot run it or choose it,
and no template lists it, though a template allows it whenever it allows any tool. It
reaches nothing outside the conversation. Tool execution details record compaction counts and indicate excerpt fallback after
reload. Cancellation prevents the next model request and summary write; already
completed filesystem side effects are not rolled back. Output token exhaustion
marks an execution failed with `output-limit` rather than declaring it complete.

## Remaining limits

- Summary text is model-generated and lossy; correct token budgeting cannot
  guarantee coding quality or prevent every forgotten detail.
- Sending real tool records across turns has been run against DeepSeek directly and
  through OpenRouter, not yet against Anthropic with thinking on. Providers differ in
  what they accept in tool history.
- The usage indicator's figure after a manual fold is an estimate until the next
  request.
- A window not much larger than the tool definitions plus the output a tool returns,
  such as 18,000 tokens for a task reading files of 4,000, keeps only excerpts of what
  was read, so a model that needs the middle of a file reads it again. The task can
  still finish, at the cost of those reads, or be stopped by the limit on folds.
- A summary holding only tool work folded during a turn ends at no message, so the
  transcript shows no marker for it.
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
real terminal: inspect, failing tests, code modification, passing tests, older
results shortened to excerpts and a reloaded follow-up; a separate test covers folds
running out of their call allowance. Model decisions and summaries in these tests
are deterministic fixtures; these checks validate execution and context contracts,
not the problem-solving quality of a real remote model.
