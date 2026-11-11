# Tasks

A task is something RiA does by itself at a time you choose. There are three kinds:

| Kind | What happens when it runs |
| --- | --- |
| **Have the model do it** | The task's prompt is sent as a message in the task's own conversation, and the model answers with the tools that conversation allows. |
| **Back up the workspace** | A workspace backup is created. No model is involved. |
| **Remind me to back up** | A reminder is raised when there has been no backup for 7 days. No model is involved. |

Open **Tasks** in the sidebar and choose **New task**, or ask in a conversation ("every weekday at 9, summarise …"). The model proposes the task with the `createTask` tool. You approve it before it is saved, and an approved task is switched on.

The tasks themselves are made and changed on the **Tasks** page. **Settings → Automation & notifications** holds only what applies to all of them: the [background task rules](#background-task-rules) and which outcomes [notify you](#being-told).

## Templates

**New task** starts from a template: **Custom task** (blank), **Daily brief**, **Weekly summary**, **Scheduled backup** or **Backup reminder**. The same templates are offered as shortcuts while the list is empty. A template only fills in the form — the name, the prompt in the interface language, and a suggested schedule — and nothing is created or run until you save it. Choosing another template replaces what the last one filled in; the time zone stays.

The daily brief and the weekly summary are ordinary prompt tasks. Their prompt asks the model to read the workspace's recorded activity with the `readWorkspaceActivity` tool and summarise it, and you can rewrite it like any other.

A task made from the brief or the summary remembers its template. The model answers in the language its prompt is written in, so as long as you have not rewritten them, the task's name and prompt are not stored at all: each time the task is shown it uses the template's wording in the interface language, and each time it runs it uses the wording in the language last chosen in the app (before one is chosen, the desktop passes the language its settings hold). Saving the form with the wording unchanged keeps the task on its template; a name or prompt you rewrote is yours and stays as you wrote it, and clearing your changes back to the template's wording hands it back. A later change to a template's wording reaches every task still using it. Only task names and prompts work this way; chat and assistant templates are not affected.

## One conversation per task

The first run of a prompt task creates a conversation named after the task. Every later run adds its prompt and answer to that same conversation, so the model sees what earlier runs said and you find all of the task's output in one place. Repeated runs never leave a trail of new conversations.

The row's name opens the conversation, and so does **Open conversation** in its ⋯ menu, a run in the run history, the task's notice in the reminder center and a click on its system notification. Each opens that conversation even when chat last had another one open. If you delete the conversation, the next run starts a new one. Deleting the task keeps its conversation and its run history.

A conversation that is open while its task runs shows the new turn without a reload: chat looks for new turns in a task's conversation every 10 seconds while the window is visible, and in any conversation when the window comes back into view. A message sent from a page that had not caught up is still answered with the task's latest turn in view, because the service fills in turns the page did not have.

The conversation starts with nothing from the conversation the task was created in, so a prompt must say everything the run needs.

A task's conversation belongs to the task. It is always a **General assistant** conversation: every tool a conversation can use and no assistant template. The template menu in its toolbar stays on General assistant, and the service refuses a request to apply a template to it.

## What a task decides

Besides its prompt and schedule, a task decides how every turn in its conversation runs, a run and a message you type there alike. These are under **Advanced** in the task form. A built-in action has no conversation and takes none of them.

- **Model**: the task's own model, or, while it is set to **Follow the default chat model** (the default), the default chat model at the time of each turn. A template's bound model plays no part. The model picker in the conversation shows the task's model, and choosing one there changes the task; **Default** hands it back to the default chat model. A model that has since been removed from the library is refused when a run starts, rather than replaced with another.
- **Working folder**: none by default, so a task starts as a conversation without a workspace. A folder chosen for the task is the one its turns work in, from the first run on, and it stays with the task if the conversation is deleted. The folder picker in the conversation changes the task's folder. Withdrawing the folder's permission clears it.
- **Approval rule**: **Ask** (the default), **Accept edits** or **Full access**, as for any conversation ([approval rules](terminal-tools.md#approval-rules)). A task runs while you are away, so under **Ask** the first file edit or command stops the run until you answer ([Approvals](#approvals)); **Accept edits** lets it edit files in its folder, **Full access** also lets it run commands there. The approval picker in the conversation changes the task's rule.
- **Long-term memory**: off by default: a task repeats the same instruction by itself, and what it says is not something you said about yourself. Turned on, the task's conversation reads and adds to MEMORY.md like any other; turned back on after a while off, nothing said while it was off is read for notes. The memory switch in the conversation changes the task's.
- **Effort**: **Follow settings** (the default) uses the reasoning setting in Settings → Models; **No thinking**, **Low**, **High** or **Max** override it for the task's turns.
- **Notifications**: which of its outcomes become system notifications, see [Being told](#being-told).

The conversation's own controls for these show the task's values and save to the task; the service refuses a request to change them on the conversation itself. Once the task is deleted, its conversation becomes an ordinary one, with no folder until you choose one, and keeps the memory switch it had.

## When a task runs

**When to run** offers:

- **Once**: a date and time.
- **Every hour**, at a chosen minute.
- **Every day**, **Weekdays**, **Every week** or **Every month**, at a chosen time.
- **Run by hand only**: no time at all. The task runs when you choose **Run now**; it is never due, so it has nothing to pause, catch up or miss.
- **Custom**: a five-field cron expression, `minute hour day-of-month month day-of-week`. For example, `0 9 * * 1-5` is 09:00 on weekdays and `*/15 * * * *` is every quarter of an hour. Lists (`1,15`), ranges (`1-5`) and steps (`*/2`) are accepted; `7` and `0` are both Sunday. When both day fields name days, either one is enough, as in cron.

Times are read in the task's IANA time zone, which starts as the device's own. A daily 09:00 stays at 09:00 local time across daylight saving changes. A time the clocks skip that day is skipped rather than moved to another hour. A time the clocks pass twice runs once, at the first. A monthly day that a month does not have (the 31st in April) skips that month.

A schedule that never occurs (`0 0 31 2 *`) is refused when saved. So is a one-off time that has passed or does not exist in its time zone.

A task that runs once is switched off after it runs at its time. Running it by hand before then leaves that time still to come. To run a used-up task again, choose a new time; switching it back on without one is refused rather than running it at once.

## While RiA is running

Tasks run only while the desktop app is running, including when it is minimised to the tray. The service looks for due tasks at startup and once a minute. There is no Windows scheduled task and no cloud scheduler. Nothing runs while the computer is off or asleep.

A machine that was asleep or closed catches up **once**: a task that was due during the gap runs on the next check, and its next run is computed from the current time. A week away owes one run, not seven.

### Missed times

A run that starts more than 10 minutes after its time is **late**: RiA was not running, the task was still busy with its previous run, or it was waiting for a background place. What happens is chosen per task under **If its time is missed**:

- **Run once when possible** (the default) runs it, and tells the model, with the request's reference data, when the run was due, how late it is and how many later times passed. A brief written three hours late can then say so and cover the gap.
- **Skip it and wait for the next time** records the run as **Missed**, sends nothing, notifies you and waits for the next time. A one-off task whose time was missed this way is used up.

Each run in the history shows the time it was due when it ran late, and how many later times of the task passed without a run of their own, whether before it could start or while it was still running. A run started by hand is never late.

Each task runs at most once at a time. Prompt tasks that start on their own take at most half of the model call places (the **Maximum concurrent calls** in Settings → Models, rounded down, at least one), so several falling due together queue behind each other instead of being refused, and your own conversation still has room. A waiting one starts as soon as a place frees up. Built-in actions do not wait for those places, but the two backup actions wait for each other, so two backups never read the workspace at once. While a restore holds the workspace, due tasks wait unclaimed and run once it ends; a restore switches every task off.

A run that was in progress when the app quit or crashed is recorded as **Interrupted** at the next start. It is not replayed. A repeating task resumes at its next time, and a one-off task stays off.

A browser-only session (`next dev` or the browser test harness) shows the tasks and can run one by hand, but runs nothing on its own.

## Approvals

A run never approves anything on your behalf. If the model calls a tool that asks first under the task's approval rule, such as a file edit or terminal command under **Ask**, or creating another task under any rule, the run stops with the request saved in the task's conversation. The task's state becomes **Needs approval** and you are notified.

Approve or reject it in the conversation, and the turn carries on as it would have with you present. Until you answer, later runs of that task do not send another message past the open request; each one records **Needs approval** and does nothing else.

Once the request is answered — approved, rejected, given up, or passed over by sending another message — the task no longer says **Needs approval**, and its notice is marked read.

## Background task rules

**Settings → Automation & notifications → Background task rules** applies to every run that starts on its own. A run you start with **Run now** is yours and is not held to these rules.

- **Runs a day** (default 20). Each automatic run counts once, however many model calls it makes as it uses tools. A run past the limit does not happen: it is recorded as **Skipped**, you are notified, and the task's next run goes ahead as planned. A one-off task whose run was skipped is used up like one that ran.
- **Estimated limit per call** and **Estimated daily limit**, in USD, are optional. They are checked for each model call against the prices set in Settings → Models, and with either one set a model without prices cannot be used by background runs. A run that reaches one stops at that step and is recorded as failed with `BACKGROUND_LIMIT`.

A day follows the budget time zone in Settings → Models. Calls made by automatic runs are reported as **Automatic task runs** in usage; calls made by runs you start by hand are reported as chat.

## Running, stopping and editing by hand

- **Run now** starts the task immediately, whether or not it is switched on, and does not switch it on.
- **Stop** ends a run in progress. It is recorded as failed with `ABORTED`. What the run had already done stays done, and a model call already sent may still be charged.
- **Edit** changes the name, prompt, schedule, time zone, model, folder or what happens to a missed time. Changing when it runs recomputes the next run; pausing, resuming, and saving the form with the schedule as it was do not, so a run already due stays due.
- **Pause** and **Turn on** switch the task off and on.
- **Delete** removes the task. A running task must be stopped first.

The kind of a task cannot be changed after it is created.

## Being told

When a prompt task finishes, fails, needs approval, is skipped or misses its time, RiA raises a notice in **Settings → Automation & notifications → Reminder center**. Each task has one notice, updated by every run, which opens the task's conversation.

The desktop app also shows these as system notifications. **Task notifications** in the same section chooses which of the five do for all tasks; all are on until you turn one off, and the choice is kept with the desktop settings. Each task also chooses under **Notifications**: **Every run** (the default), **Important only** (everything but a run that simply finished) or **Off**. A notification is shown only when both allow it. The notice in the reminder center is kept either way. A notice is handed to the desktop once per run, and only while it is unread. It is marked before the notification is requested, so a crash or a refused notification is not retried. The notice stays in the app either way.

Clicking a system notification brings the window forward on the task's conversation; the page moves there itself, so a draft elsewhere is kept. A system notification shows the task's name, which may appear on the lock screen. Windows notification settings, Focus Assist and Do Not Disturb can still hide it.

## Costs and limits

A prompt task makes the same model calls a message would, and each run can be charged. The model call limits in **Settings → Models** apply to these calls, and automatic runs are also held to the [background task rules](#background-task-rules).

A workspace holds up to 200 tasks. A prompt can be up to 20,000 characters and a name up to 120. Run history keeps at most 1,000 finished runs for up to 90 days; the page shows the latest 50.

## Upgrading from to-dos

Earlier versions had a to-do list with due reminders, and four fixed schedule kinds in the settings. The `20261110100000_unified_tasks` migration converts them:

- Unfinished to-dos become prompt tasks that are **switched off**. The title and details become the prompt. A deadline, if there was one, becomes a one-off time; it is usually in the past, so choose a new time before switching one on.
- Finished to-dos are not carried over.
- Scheduled backups and backup reminders keep their kind, time and on/off state.
- The daily brief and weekly summary become ordinary prompt tasks, **switched off**. A run now makes model calls with tools, which the old schedule never did, so whether they run again is your decision. They are linked to their templates (`20261112100000_task_templates`), so they are worded in the interface language like a brief made today.
- `20261115100000_task_settings` adds the task's memory switch, notification choice and effort, and lets a task have no next time. A task whose conversation already had memory on keeps it on; every other task starts with it off. The approval rule comes from `20261114100000_approval_rules` ([approval rules](terminal-tools.md#approval-rules)).

The desktop app backs up the database before applying the migration, and that backup still holds every to-do. Older application versions cannot read the converted tables; restoring the pre-upgrade database copy is the way back.

Workspace archives keep their `tasks` field, which is now always empty. Restoring an older archive does not bring its to-dos back.

## API

All endpoints require the normal local credential, Host and Origin checks, return `Cache-Control: no-store`, and share a rate limit of 30 changes per minute.

| Endpoint | Behaviour |
| --- | --- |
| `GET /api/tasks` | `{ data: Task[], automaticExecution }`. `automaticExecution` is true only in the desktop service. |
| `POST /api/tasks` | Creates a task; 201. See the fields below. |
| `PATCH /api/tasks/:id` | Changes `title`, `prompt`, `enabled`, `cron`, `runAt`, `timeZone`, `catchUp`, `model`, `workspaceGrantId`, `approvalRule`, `usesMemory`, `notify` or `reasoningEffort`. A `runAt` ends a repeat; a `cron` replaces a one-off time; `cron: null` with `runAt: null` makes the task run only by hand. A schedule sent back unchanged leaves the next run where it was. |
| `DELETE /api/tasks/:id` | Deletes the task; 409 while it runs, 404 when it is not there. |
| `POST /api/tasks/:id/run` | Starts a run and answers 202 once it has started; 409 if it is already running. |
| `POST /api/tasks/:id/stop` | Stops a run in progress; 202, or 409 when it is not running. |
| `GET /api/tasks/runs` | The latest 50 runs, optionally `?taskId=`. A run keeps its task's current name, or `null` after the task is deleted. |
| `POST /api/tasks/notifications` | Desktop only (403 elsewhere). A **claim**, not a read: returns up to 10 notices not yet shown and marks them shown. |

Creation fields:

| Field | Meaning |
| --- | --- |
| `kind` | `prompt` (default), `scheduledBackup` or `backupReminder`. |
| `title` | 1–120 characters. |
| `prompt` | Required for `prompt`, refused for the built-in actions. |
| `cron` or `runAt` | At most one; with neither, the task runs only by hand. `runAt` is a local `YYYY-MM-DDTHH:mm` read in `timeZone`, or an ISO instant with an offset. |
| `timeZone` | An IANA name; numeric offsets are refused. |
| `enabled` | Defaults to `false`, so a client that forgets it creates a task that does nothing. |
| `model` | `{ providerId, modelId }` of a model added for chat, or `null` (default) to follow the default chat model. Prompt tasks only. |
| `workspaceGrantId` | A granted folder, or `null` (default) for none. Prompt tasks only. |
| `approvalRule` | `ask` (default), `acceptEdits` or `full`. Prompt tasks only. |
| `usesMemory` | `false` (default) or `true`. Prompt tasks only. |
| `notify` | `all` (default), `important` or `off`. Prompt tasks only. |
| `reasoningEffort` | `null` (default, follow Settings → Models), `off`, `low`, `high` or `max`. Prompt tasks only. |

A task reads back with `id`, `kind`, `title`, `prompt`, `enabled`, `cron`, `timeZone`, `catchUp`, `model`, `workspaceGrantId`, `approvalRule`, `usesMemory`, `notify`, `reasoningEffort`, `chatId`, `nextRunAt` (`null` for a task run only by hand), `lastRunAt`, `lastStatus` (`running`, `done`, `failed`, `interrupted`, `waiting_approval`, `skipped`, `missed` or null) and `lastError`. A run's status is `running`, `succeeded`, `failed`, `interrupted`, `waiting_approval`, `skipped` or `missed`; a run also has `scheduledFor` (when it was due, for one that started on its own), `late` and `missedCount`.

`catchUp` (default `true`) can be given on creation and changed with `PATCH`. A prompt task may be created with `template` (`dailyBrief` or `weeklySummary`); its `title` may then be empty and its `prompt` left out, and `PATCH` with an empty `title` or a `null` prompt hands that part back to the template. A task reads back its stored `title` and `prompt` (empty and `null` while it uses the template) with its `template`. `PUT /api/interface-locale` with `{ "locale": "zh-CN" | "en-US" }` saves the interface language the user chose; the interface sends it when the language is switched.

The `createTask` tool takes `title`, `prompt`, `timeZone` and exactly one of `cron` or `runAt`, and creates a switched-on prompt task that follows the default chat model and has no folder. It always asks for approval.

A conversation reads back with `task`: `{ id, model }` for a task's conversation, otherwise `null`. For a task's conversation `workspaceGrantId`, `approvalRule` and `ephemeral` are the task's and `assistantConfig` is `null`. `PATCH /api/conversations/:id` answers 409 to `assistantTemplateId`, `workspaceGrantId`, `approvalRule` or `ephemeral` for a task's conversation; change them on the task. A chat request for a task's conversation that names a model other than the task's is refused with 400.

## Verification

Server tests cover cron parsing and daylight saving, one-off times, concurrent claims, catch-up, late and missed runs, interruption, restore deferral, one conversation across runs, a deleted conversation, a message from a page that missed a run, provider failure, approvals that stop a run and settle once answered, stopping, notification claims, rewording into the interface language, the task's model deciding run and typed turns, the task's folder, a refused template, an unchanged schedule on edit, tasks run only by hand, the task's memory switch, effort and notification choice, settings refused for built-in actions, and the route boundaries. A desktop migration test converts to-dos and every old schedule kind, and moves a folder chosen in a task's conversation onto its task. Browser tests create, edit, run, pause and delete tasks through the page, and run a due task through the real desktop startup scheduler against the offline model fixture.

Automated checks do not establish Windows notification display, Focus Assist, physical sleep and wake, or real-model behaviour. Check those by hand before a release.
