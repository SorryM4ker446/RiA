# Checklists and questions

Two tools let the model show its plan and ask for decisions. Both are the model's own: no one picks them in the composer, and templates allow them along with any tool.

## Task checklist (`updatePlan`)

Whether to keep a checklist is the model's judgement, by whether the user would want to follow progress: work that takes a while or many tool calls (changes across several files, a build-test-fix loop, an investigation in stages) or several separate requests. A few quick actions, a single answer or conversation get none, since a card there is only noise. The tool's description says this with worked examples of both (a write-test-fix task, a rename across many files and several reports to summarise get a checklist; creating one file or answering a question do not), and the system prompt repeats it in one line while the workspace tools are offered.

During a long turn RiA also reminds the model, the way Claude Code reminds its agent: when a turn reaches 5 tool calls without a checklist (and again at 10, 15 …), the next model step carries a short note saying so and leaving the choice to the model; once a checklist exists and is unfinished, every 5 calls after its last update the note shows it back so finished steps get ticked. The note goes with that one step only, after everything else in the request (so the prompt before it stays cacheable), and is never saved in the conversation. The model writes the checklist before it starts and updates it as it goes. Each call states the whole list as it now stands (up to 20 steps): pending, in progress (at most one), or completed. It marks a step done as soon as it is done, and adds or drops steps as the work changes.

- **In the answer, while the work runs.** The checklist is one card where the model first wrote it; each update redraws that card. A step in progress has a turning ring, a completed one a filled check, and a thin bar shows how far it got; the card can be folded to one line. As in Claude Code it is a view of work in progress, not part of the answer: it folds away as soon as the final written answer starts (text after the last tool call), and is not shown for an answer that has ended, after a reload included.
- **Above the composer.** While the answer runs, the step in progress stays in view in a small strip ("Now: run the tests · 3/5"); a click scrolls to the card.
- **Not a tool listing.** The checklist does not appear among the tools an answer used. Execution records keep each call, so the plan of a finished answer can still be looked up there.
- **After a compaction.** The latest checklist is kept in the record the application writes under a summary, so a long task keeps its plan when earlier turns are folded.

The tool does nothing besides showing the plan; it returns how many steps are done and which one is current.

## Questions (`askUser`)

When the right way forward depends on a decision only the user can make (an approach, a format, a scope), the model can ask 1 to 3 questions, each with 2 to 5 short options; a recommended option comes first and says so. It is told not to ask what it can find out itself, what the user already said, or for permission to do what was asked.

Asking pauses the turn the same way an approval does: the conversation shows it is waiting, and notifications and unread marks behave as for approvals. The question appears where approval cards do:

- Options are whole rows, radio rows for one choice and checkbox rows for several, each with an optional line of explanation. **Other…** opens a line to answer in your own words.
- One question with one choice is answered by choosing. Otherwise **Next** goes through the questions (with **Back**), and **Submit** sends them. Every question needs an answer.
- ↑ and ↓ move between rows, and a number picks that option.
- **Skip** lets the model decide; it is told to say what it assumed.
- Typing in the message box while a question waits answers it in your own words (the box says so).

The answer travels as the approval's reason and is checked against the saved question before the turn goes on: only offered options, one where one is asked, every question answered. An answer that does not fit is refused and the question stays open. Afterwards the answer stays in the conversation as a quiet "question / answer" record under the reply, and survives a reload.

Under every approval rule, Auto and Full access included, a question waits for the user. Scheduled tasks are not offered the tool, since no one is there to answer.
