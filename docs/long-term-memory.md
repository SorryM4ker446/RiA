# Long-term memory

Long-term memory is **MEMORY.md**: what the model has noted on its own, one line per note,
under four sections for who the user is, preferences and corrections, ongoing work and
decisions, and where to find things. It works only while a conversation's long-term memory
switch is on. It travels with backups. **Settings → Your RiA** has two entries: **Memory**,
the notes sorted by the model into topics, and **MEMORY.md**, the text itself.

Knowledge entries are a different thing: part of the [knowledge base](document-knowledge.md),
saved on request and found by matching. The switch does not touch them.

## How a note gets written

Judging and extracting are separate, so neither can stand in for the other.

**Judging.** The chat model decides, by calling the `extractMemory` tool. Its description
says most turns do not qualify and spells out what does: something that will matter in a
future, unrelated conversation and that MEMORY.md does not already say. It leaves out this
task's progress, what a document or history records, small talk and guesses. The tool is
offered only while memory is on, in any template that allows a tool, and stops if the user
says in the conversation not to use it, like every tool only the model calls.

Whatever the model judges, a conversation must add five user messages before it can ask
again, so this cannot run every turn. The tool says `too-soon` and the answer carries on.
When the user plainly asks it to remember something, the model says so with `userAsked`,
which skips that wait. What gets written still comes only from what the user wrote.

**Extracting.** A separate call then reads the current notes and the conversation's latest
forty messages, in the background, so the answer does not wait. It runs on the auxiliary
model when one is chosen, and on the conversation's model if there is none or it fails. It
follows the conversation's thinking setting.

It reads nothing from before memory was last turned back on, so what was said with the switch
off stays out. What the user said not to keep stays out too, and when they ask to forget
something the matching lines are removed.

It sees what the user wrote in full, and assistant replies only as short context. No tool
result reaches it, and only what the user wrote or plainly confirmed may become a note, so
a web page or file cannot write itself into memory. The model's hint says where to look
and is not evidence. "No changes" is the usual outcome.

It answers with changes by line number: add, replace or remove. They are applied
mechanically, so one bad reply cannot lose the rest; a reply that cannot be read changes
nothing. A write checks the revision it read, so a person's deletion during the call
stands. If another extraction moved the document instead, it reads the document again and
tries once more, so two conversations noting at once both get written. The document holds at most 200 lines and 25,000 characters, the amount Claude Code
loads, each note up to 500 characters. Once full, new notes stay out until the model
replaces or removes old ones.

## Topics

Topics are for a person to look through the notes. After an extraction writes, a further
background call reads the notes and the current topics, and replies with which lines belong
to which topic, a title and a one-sentence summary. It runs on the auxiliary model when one
is chosen, and on the conversation's model if there is none or it fails. From Settings,
where there is no conversation, the default chat model stands in.

MEMORY.md stays the only source. Topics are joined to it when read, so they cannot show a
note that is not there or hide one: a line the reply did not know or already placed is
ignored, and a note no topic holds appears under **Not sorted**. A result is written only
over the revision it read; if the document moved during the call, it runs again. A failure
or an unreadable reply leaves the notes readable as not sorted, with **Sort again**. Opening
the page tries once if anything is unsorted. Topics are never sent to a model as memory.

A person can open a topic to read its summary and notes, reword or delete one note, or
delete the topic and all its notes. What they delete leaves the stored topics in the same
write as the document, along with any summary that may mention it; that summary is then
written again in the background. Titles and summaries are the model's and cannot be edited.

## How it reaches the model

The document goes in the context block of a user message the first time a conversation
needs that revision, and is then repeated exactly with that message, so a provider's prompt
cache keeps matching. A later revision is added beside it, labelled as replacing the earlier
copy, and a fold that takes the copy away brings it back on the next request.

When a person deletes a note, earlier copies are no longer sent, which misses the cache once.
With memory off the document does not go to the model, including copies in earlier messages,
and the tool is not offered. The rest of each message's block stays as it was.
