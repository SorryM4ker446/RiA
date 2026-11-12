"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, BellRing, MessageSquareText, MoreHorizontal, Pause, PencilLine, Play, Plus, Sparkles, Square, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Reveal } from "@/components/ui/reveal";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { describeSchedule, isManualTask, taskApi, taskState, taskTitle, type ScheduledRunView, type TaskDraft, type TaskState, type TaskView } from "@/features/tasks/task-client";
import { TaskEditor } from "@/features/tasks/task-editor";
import { TaskHistory } from "@/features/tasks/task-history";
import { conversationHref } from "@/features/chat/open-conversation";
import { TASK_TEMPLATES, type TaskTemplateId } from "@/features/tasks/task-templates";
import { formatDateTime, localizeMessage, t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { useConversationStore } from "@/features/chat/conversation-store";

const ICONS = { prompt: Sparkles, scheduledBackup: Archive, backupReminder: BellRing } as const;
const TONES: Record<TaskState, "neutral" | "success" | "warning" | "danger"> = {
  running: "warning", waiting: "warning", failed: "danger", skipped: "warning", missed: "warning", paused: "neutral", finished: "neutral", scheduled: "success", manual: "neutral",
};


/** Changes said together (a run's claim, its conversation, its end) are read once. */
const CHANGE_COALESCE_MS = 120;

export default function TasksPage() {
  useLocale();
  const toast = useToast();
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [runs, setRuns] = useState<ScheduledRunView[]>([]);
  const [automatic, setAutomatic] = useState(true);
  const [loading, setLoading] = useState(true);
  // A change that was refused, and a list that could not be read, are said separately:
  // reading the list again after a refused change must not wipe out why it was refused.
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The task in the editor: null for a new one. `enable` switches it on with the save.
  const [editing, setEditing] = useState<{ task: TaskView | null; enable?: boolean; template?: TaskTemplateId } | null>(null);
  const reading = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const [list, history] = await Promise.all([taskApi.list(controller.signal), taskApi.runs(controller.signal)]);
      if (controller.signal.aborted) return;
      setTasks(list.data);
      setAutomatic(list.automaticExecution);
      setRuns(history.data);
      setLoadError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : t("tasks.loadFailed"));
    } finally {
      if (reading.current === controller) { reading.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => { void load(); return () => reading.current?.abort(); }, [load]);
  useRefreshOnReturn(load);
  // The service says when a run starts or ends, or a task changes elsewhere; the
  // list is read again then (one read for a burst of them), not on a timer.
  const { onChanged } = useConversationStore();
  useEffect(() => {
    let timer = 0;
    const off = onChanged(() => { window.clearTimeout(timer); timer = window.setTimeout(() => void load(), CHANGE_COALESCE_MS); });
    return () => { off(); window.clearTimeout(timer); };
  }, [onChanged, load]);

  /** Runs one change, says it worked, and reads the list again; a refusal is shown above the list. */
  async function act(change: () => Promise<unknown>, done: string) {
    try {
      await change();
      setError(null);
      toast(done);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tasks.saveFailed"));
    }
    await load();
  }

  async function save(draft: TaskDraft) {
    const target = editing?.task;
    if (target) {
      const { kind: _kind, ...patch } = draft;
      await taskApi.update(target.id, { ...patch, ...(editing?.enable ? { enabled: true } : {}) });
    } else {
      await taskApi.create({ ...draft, enabled: true });
    }
    setEditing(null);
    toast(target ? t("tasks.toast.saved") : t("tasks.toast.created"));
    await load();
  }

  async function remove(task: TaskView) {
    if (!await confirm({ title: t("tasks.confirm.deleteTitle"), description: t("tasks.confirm.deleteDescription"), action: t("ui.confirm.delete"), destructive: true })) return;
    try {
      await taskApi.remove(task.id);
      await animateRemoval(task.id, () => setTasks(current => current.filter(item => item.id !== task.id)));
      setError(null);
      toast(t("tasks.toast.deleted"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tasks.deleteFailed"));
    }
    await load();
  }

  function toggle(task: TaskView) {
    // A task that already ran once has no time left to run at, so switching it on starts by choosing one.
    if (!task.enabled && !task.cron && task.nextRunAt && new Date(task.nextRunAt).getTime() <= Date.now()) { setEditing({ task, enable: true }); return; }
    void act(() => taskApi.update(task.id, { enabled: !task.enabled }), task.enabled ? t("tasks.toast.paused") : t("tasks.toast.resumed"));
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title={t("tasks.title")}
        description={t("tasks.description")}
        actions={<Button size="sm" onClick={() => setEditing({ task: null })}><Plus data-icon="inline-start" aria-hidden="true" />{t("tasks.create")}</Button>}
      />
      {!automatic ? <p className="-mt-2 text-xs text-warning">{t("tasks.notAutomatic")}</p> : null}
      <Reveal className="-mt-6">{error ?? loadError ? <p role="alert" className="mt-6 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage((error ?? loadError)!)}</p> : null}</Reveal>

      {/* Loading takes the same box as the empty list, so nothing below it moves when the list arrives. */}
      {loading ? <p role="status" className="empty-state">{t("tasks.loading")}</p>
        : !tasks.length ? (
          <div className="flex flex-col gap-3">
            <p className="empty-state pb-0">{t("tasks.empty")}</p>
            {/* Starting points, not tasks: each opens the form filled in, and nothing runs until it is saved. */}
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("tasks.templates.label")}>
              {TASK_TEMPLATES.filter(id => id !== "custom").map(id => (
                <Button key={id} size="sm" variant="outline" onClick={() => setEditing({ task: null, template: id })}>{t(`tasks.template.${id}`)}</Button>
              ))}
            </div>
          </div>
        )
        : (
          <ul className="item-list" aria-label={t("tasks.listLabel")}>
            {tasks.map(task => {
              const state = taskState(task);
              const Icon = ICONS[task.kind as keyof typeof ICONS] ?? Sparkles;
              const upcoming = task.enabled && state !== "running";
              return (
                <li key={task.id} {...removalKey(task.id)} className="item-row" data-testid="task-item" data-task-state={state}>
                  <span className="item-row-icon"><Icon aria-hidden="true" /></span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <h2 className="text-sm font-medium">
                      {task.chatId
                        ? <Link className="item-row-open break-words" href={conversationHref(task.chatId)}>{taskTitle(task)}</Link>
                        : <button type="button" className="item-row-open break-words text-left" onClick={() => setEditing({ task })}>{taskTitle(task)}</button>}
                    </h2>
                    <p className="line-clamp-1 break-words text-xs text-muted-foreground">
                      {describeSchedule(task)}
                      {upcoming && task.cron && task.nextRunAt ? ` · ${tf("tasks.next", { time: formatDateTime(task.nextRunAt) })}` : ""}
                      {!upcoming && task.lastRunAt ? ` · ${tf("tasks.last", { time: formatDateTime(task.lastRunAt) })}` : ""}
                    </p>
                  </div>
                  <Status tone={TONES[state]}>{t(`tasks.state.${state}`)}</Status>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" className="item-row-action" aria-label={tf("ui.assistants.moreActionsFor", { v0: taskTitle(task) })}><MoreHorizontal aria-hidden="true" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        {state === "running"
                          ? <DropdownMenuItem onSelect={() => void act(() => taskApi.stop(task.id), t("tasks.toast.stopping"))}><Square aria-hidden="true" />{t("tasks.action.stop")}</DropdownMenuItem>
                          : <DropdownMenuItem onSelect={() => void act(() => taskApi.run(task.id), t("tasks.toast.started"))}><Play aria-hidden="true" />{t("tasks.action.runNow")}</DropdownMenuItem>}
                        {task.chatId ? <DropdownMenuItem asChild><Link href={conversationHref(task.chatId)}><MessageSquareText aria-hidden="true" />{t("tasks.action.openConversation")}</Link></DropdownMenuItem> : null}
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem disabled={state === "running"} onSelect={() => setEditing({ task })}><PencilLine aria-hidden="true" />{t("tasks.action.edit")}</DropdownMenuItem>
                        {/* A task run only by hand has nothing to pause. */}
                        {isManualTask(task) ? null : <DropdownMenuItem onSelect={() => toggle(task)}>{task.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}{task.enabled ? t("tasks.action.pause") : t("tasks.action.resume")}</DropdownMenuItem>}
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem variant="destructive" disabled={state === "running"} onSelect={() => void remove(task)}><Trash2 aria-hidden="true" />{t("chat.common.delete")}</DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}

      {!loading && runs.length ? (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">{t("tasks.history.title")}</summary>
          <div className="pt-3"><TaskHistory runs={runs} /></div>
        </details>
      ) : null}

      <Dialog open={editing !== null} onOpenChange={open => { if (!open) setEditing(null); }}>
        <DialogContent>
          <div className="flex flex-col gap-1 pr-8">
            <DialogTitle className="text-base font-semibold">{editing?.task ? t("tasks.editTitle") : t("tasks.create")}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">{t("tasks.editorDescription")}</DialogDescription>
          </div>
          {/* Keyed by what is being edited, so opening another task starts from that task's values. */}
          {editing ? <TaskEditor key={editing.task?.id ?? `new-${editing.template ?? "custom"}`} task={editing.task} template={editing.template} onSave={save} onCancel={() => setEditing(null)} /> : null}
        </DialogContent>
      </Dialog>
    </main>
  );
}
