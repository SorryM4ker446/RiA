"use client";

import Link from "next/link";
import { Status } from "@/components/ui/status";
import { SettingsLink } from "@/features/settings/settings-context";
import type { ScheduledRunView } from "@/features/tasks/task-client";
import { conversationHref } from "@/features/chat/open-conversation";
import { executionGuidance } from "@/lib/execution-messages";
import { formatDateTime, t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

const TONES = { running: "warning", succeeded: "success", failed: "danger", interrupted: "danger", waiting_approval: "warning", skipped: "warning", missed: "warning" } as const;
const KINDS = ["prompt", "scheduledBackup", "backupReminder"];

function statusLabel(status: string) {
  return status in TONES ? t(`tasks.run.${status as keyof typeof TONES}`) : status;
}

/** What each run did, newest first. A record outlives its task, so a deleted task's runs still say what happened. */
export function TaskHistory({ runs }: { runs: ScheduledRunView[] }) {
  useLocale();
  if (!runs.length) return <p className="text-sm text-muted-foreground">{t("tasks.history.empty")}</p>;
  return (
    <ul className="item-list" aria-label={t("tasks.history.title")}>
      {runs.map(run => (
        <li key={run.id} className="item-row">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="truncate text-sm">{run.title ?? (KINDS.includes(run.kind) ? t(`tasks.kind.${run.kind as "prompt"}`) : t("tasks.history.deleted"))}</p>
            <p className="text-xs text-muted-foreground">
              <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>
              {run.trigger === "manual" ? ` · ${t("tasks.run.manual")}` : ""}
              {/* A run that started well after its time says when it was due. */}
              {run.late && run.scheduledFor ? ` · ${tf("tasks.run.late", { time: formatDateTime(run.scheduledFor) })}` : ""}
              {run.missedCount ? ` · ${tf("tasks.run.missedCount", { count: String(run.missedCount) })}` : ""}
              {run.errorCode ? ` · ${executionGuidance(run.errorCode)}` : ""}
            </p>
          </div>
          {run.chatId ? <Link className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline" href={conversationHref(run.chatId)}>{t("tasks.action.openConversation")}</Link> : null}
          {run.backupId ? <SettingsLink className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline" section="backups">{t("tasks.history.viewBackup")}</SettingsLink> : null}
          <Status tone={TONES[run.status as keyof typeof TONES] ?? "neutral"}>{statusLabel(run.status)}</Status>
        </li>
      ))}
    </ul>
  );
}
