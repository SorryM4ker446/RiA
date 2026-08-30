# Task reminders and recurrence

Create a task from the manual tool or an approved assistant action. In the task panel, open **设置时间与提醒** to set its deadline, IANA time zone, **到期桌面通知**, and **重复** rule. Past-due unfinished tasks show **已逾期**; completed tasks do not. The badge refreshes every 30 seconds and when the window regains focus.

## Dates and recurrence

Deadlines are stored as UTC instants with a separate task time zone. The manual tool uses the browser's current zone; the settings form lets you choose a zone such as `Asia/Shanghai` or `America/New_York`. Changing the zone in the form reinterprets the entered wall time in that zone. Existing tasks keep their stored instants and receive `UTC`, notifications off and no recurrence during migration.

Daily, weekly and monthly tasks create **one new pending task when completed**. The original stays completed. The next deadline is after both the previous deadline and the completion time: completing a task late skips missed occurrences rather than creating a backlog. Completing early still advances from the previous deadline. A task does not generate occurrences just because time passes.

Recurrence preserves the original local time and monthly day. January 31 becomes February's last day, then March 31; leap years are respected. Manually entered nonexistent local times at a daylight-saving transition are rejected. Recurrence moves such times forward through the clock gap for that occurrence, then returns to the original local time. Ambiguous times when clocks move backward use the earlier occurrence. Supply an explicit UTC offset through the API if the later occurrence is intended. Time-zone rules come from the installed runtime's ICU database.

The original task's completion and its successor are written in one SQLite transaction. Concurrent or retried completion cannot generate a second successor, even after restart, reopening the completed task, or deleting its successor. Edit the new task to change or stop the series. Turning repetition off before completion prevents a successor. Deleting a task does not delete previous or subsequent tasks. Clearing a deadline requires disabling its reminder and repetition in the same update.

## Desktop delivery and limits

The Electron main process checks on startup, every 30 seconds and after system resume. It pauses polling while the local service restarts and waits for an in-flight check before shutdown. Only the current user's enabled, unfinished, due tasks are eligible. Each check claims at most 10 tasks, oldest first, through the authenticated local service. A backlog can take several checks. Clicking a notification focuses the existing window without discarding the active conversation or draft.

This requires the desktop application to be running. Closing all windows exits the application and stops its service; there is no tray process, Windows scheduled task, cloud scheduler or notification while powered off. On the next launch, unclaimed overdue tasks are checked. A browser-only session shows deadlines and saves settings but does not send operating-system notifications.

Claims are persisted **before** requesting native notification display. This avoids replay after concurrent checks and restarts, but is not guaranteed delivery: a crash, lost HTTP response, or OS rejection after claiming can lose that notification. Notifications are not automatically retried after a successful claim. Disabling/re-enabling reminders or reopening a task does not replay the claim; explicitly changing the deadline schedules a new reminder. A system that reports notifications unsupported is not asked to claim tasks. Focus Assist/Do Not Disturb, OS permission settings and Windows application registration can still suppress display even when the API reports support. Use the overdue task list as the durable record.

The notification contains the task title and deadline, which may appear on the lock screen. No task details are included and no task text or credentials are written to reminder diagnostics. Enable reminders only when this exposure is acceptable. Native objects retained for click handling are limited to 30; older notifications are closed when this limit is reached.

## API contract

`createTask` tool input and `PATCH /api/tasks/:id` accept these schedule fields:

| Field | Meaning |
| --- | --- |
| `dueDate` | ISO date/date-time, or null to clear; explicit offsets preserve the instant; date-only means midnight in the task zone |
| `timeZone` | Valid IANA time zone, default `UTC` when creating; offset-only zone names are rejected |
| `reminderEnabled` | Boolean, default false; requires a deadline |
| `repeatRule` | `none`, `daily`, `weekly`, `monthly`; default `none`; repetition requires a deadline |

Updates merge with the stored schedule before validation. A zone-only API update preserves the existing instant; send both `dueDate` and `timeZone` to reinterpret wall time. Other task fields retain their existing contracts. Invalid calendars, time zones, rules, booleans and unknown fields return `400 VALIDATION_ERROR` with no partial update. Server-owned `remindedAt`, `repeatAnchor` and `repeatGenerated` are read-only. The PATCH response adds `nextTask` (the created successor or null) alongside the existing `data` task. Clients should merge the successor by ID into their task list.

The settings form displays minutes, but saving reminder options without editing the displayed date/time or zone preserves the original instant, including seconds, milliseconds and the selected side of a DST clock rollback.

`POST /api/tasks/reminders` is a desktop-only **claim operation**, not a read endpoint. It accepts an empty body or `{}`, returns `{ "data": [...] }` containing task IDs, titles, UTC deadlines and time zones, and marks those tasks claimed in the same transaction. Do not call it to preview reminders. It requires the normal user, desktop Cookie, Host and Origin checks and allows 10 checks per user per minute. Non-desktop callers receive `403`; foreign task updates return `404`; unauthorized or expired Web sessions receive `401`. Quotas are process-local, while claims and recurrence state survive service restarts.

No extra environment variable, API key, external service or dependency is required. Existing Web and desktop migration entrypoints apply the additive task migration. Back up the database before upgrading; do not modify notification state with ad-hoc SQL in a real user database.

## Verification boundary

Server tests cover calendars/DST, monthly anchors, invalid and unauthorized updates, atomic rollback, concurrent completion/claiming, reconnects, quotas and expired sessions. Browser integration tests use real HTTP and isolated SQLite with network access denied at the model boundary. Desktop tests exercise migration/backups, polling and a native-notification adapter double. Electron smoke uses its real main process, Cookie boundary, local service, task API and restart flow, with an isolated fixture and a recording notification sink to avoid displaying notifications during automation.

Automated checks establish dispatch behavior, not Windows notification-center/lock-screen delivery. Installed-application notification display, Focus Assist, physical sleep/wake, installer upgrade/uninstall/reinstall and other operating systems require separate manual release validation. No installer is needed for the local unit, browser or runtime smoke checks.
