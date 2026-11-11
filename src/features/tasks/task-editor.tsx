"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Reveal } from "@/components/ui/reveal";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TimeInput } from "@/components/ui/time-input";
import { TaskDateTimeButton } from "@/features/tasks/task-date-time-field";
import { isManualTask, localTimeZone, taskPrompt, taskTitle, templateWording, weekdayName, type TaskDraft, type TaskView } from "@/features/tasks/task-client";
import { Checkbox } from "@/components/ui/checkbox";
import { APPROVAL_RULES, type ApprovalRule } from "@/lib/approvals/rules";
import { TASK_EFFORTS, TASK_NOTIFY, type TaskEffort, type TaskNotify } from "@/lib/scheduler/task-settings";
import { loadAccountChatDefaults, parseModelRefValue } from "@/features/chat/preferences";
import { fetchGrants, type WorkspaceGrant } from "@/features/chat/directory-permissions";
import { localizeMessage, t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { cronOfPreset, isTimeZone, localInputOf, parseCron, presetOfCron, type SchedulePreset } from "@/lib/scheduler/cron";
import { modelRefKey, type ModelLibraryItem, type ModelRef } from "@/lib/models/preferences-schema";
import { cn } from "@/lib/utils/cn";
import { TASK_TEMPLATES, taskTemplate, type TaskTemplateId } from "@/features/tasks/task-templates";

// "manual" runs only when started by hand: no repeat and no time.
const REPEATS = ["once", "hourly", "daily", "weekdays", "weekly", "monthly", "custom", "manual"] as const;
type Repeat = (typeof REPEATS)[number];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
/** The model and folder choices that store nothing: follow the default chat model, work in no folder. */
const DEFAULT_MODEL = "__default";
const NO_FOLDER = "__none";
/** The effort choice that stores nothing: follow the app's reasoning setting. */
const APP_EFFORT = "__app";

/** Tomorrow at nine, the time a new one-off task starts from. */
function tomorrowMorning(): string {
  const day = new Date(Date.now() + 86_400_000);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}T09:00`;
}

/** The time zone as a place name: "Shanghai" for Asia/Shanghai. */
const zoneLabel = (zone: string) => zone.split("/").at(-1)?.replaceAll("_", " ") || zone;

/** One setting in a group: its name on the left, its value on the right. */
function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="form-row">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
      <div>{children}</div>
    </div>
  );
}

/** What a task's model and folder are chosen from: the chat models and the granted folders. */
function useTurnChoices() {
  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelRef | null>(null);
  const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
  useEffect(() => {
    let active = true;
    // Either list may fail to load; the server checks every choice anyway.
    void loadAccountChatDefaults().then(value => {
      if (!active) return;
      setModels(value.library.filter(model => model.modes.includes("chat")));
      setDefaultModel(value.preferences.selectedChatModel);
    }).catch(() => undefined);
    void fetchGrants().then(list => { if (active && list) setGrants(list); });
    return () => { active = false; };
  }, []);
  return { models, defaultModel, grants };
}

/**
 * The form for a new task or an existing one. Saving hands the caller a whole
 * task; nothing is written until then, and a refused save leaves every field
 * as it was typed.
 *
 * What to do comes first, then when, then — folded away until wanted — what
 * each run works with: its model and folder, what happens to a missed time and
 * the time zone the schedule is read in.
 */
export function TaskEditor({ task, template = "custom", onSave, onCancel }: {
  task: TaskView | null;
  /** The template a new task starts from. */
  template?: TaskTemplateId;
  onSave: (draft: TaskDraft) => Promise<void>;
  onCancel: () => void;
}) {
  useLocale();
  const id = useId();
  const start = task ? null : taskTemplate(template);
  const initial = task ? presetOfCron(task.cron) : start!.schedule;
  const [templateId, setTemplateId] = useState<TaskTemplateId>(template);
  const [kind, setKind] = useState<TaskDraft["kind"]>((task?.kind as TaskDraft["kind"]) ?? start!.kind);
  // A task still using its template's wording shows that wording, in the language the interface is in now.
  const [title, setTitle] = useState(task ? taskTitle(task) : start!.title);
  const [prompt, setPrompt] = useState(task ? taskPrompt(task) : start!.prompt);
  const [timeZone, setTimeZone] = useState(task?.timeZone ?? localTimeZone());
  const [repeat, setRepeat] = useState<Repeat>(task && isManualTask(task) ? "manual" : initial.type);
  const [time, setTime] = useState("time" in initial ? initial.time : "09:00");
  const [minute, setMinute] = useState(initial.type === "hourly" ? String(initial.minute) : "0");
  const [dayOfWeek, setDayOfWeek] = useState(initial.type === "weekly" ? initial.dayOfWeek : 1);
  const [dayOfMonth, setDayOfMonth] = useState(initial.type === "monthly" ? String(initial.dayOfMonth) : "1");
  const [cron, setCron] = useState(initial.type === "custom" ? initial.cron : "0 9 * * 1-5");
  // A task that already ran once opens on a fresh time rather than the one that passed.
  const [runAt, setRunAt] = useState(() => task && !task.cron && task.nextRunAt && new Date(task.nextRunAt).getTime() > Date.now() ? localInputOf(new Date(task.nextRunAt), task.timeZone) : tomorrowMorning());
  const [catchUp, setCatchUp] = useState(task?.catchUp ?? true);
  const [model, setModel] = useState(task?.model ? modelRefKey(task.model) : DEFAULT_MODEL);
  const [folder, setFolder] = useState(task?.workspaceGrantId ?? NO_FOLDER);
  const [approvalRule, setApprovalRule] = useState<ApprovalRule>(task?.approvalRule ?? "ask");
  const [usesMemory, setUsesMemory] = useState(task?.usesMemory ?? false);
  const [notify, setNotify] = useState<TaskNotify>(task?.notify ?? "all");
  const [effort, setEffort] = useState<string>(task?.reasoningEffort ?? APP_EFFORT);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = useTurnChoices();
  const defaultModelName = choices.defaultModel ? choices.models.find(item => modelRefKey(item) === modelRefKey(choices.defaultModel!))?.name ?? choices.defaultModel.modelId : null;

  /** Starting from another template replaces what it fills in; the time zone, model and folder stay. */
  function chooseTemplate(next: TaskTemplateId) {
    const filled = taskTemplate(next);
    setTemplateId(next);
    setKind(filled.kind);
    setTitle(filled.title);
    setPrompt(filled.prompt);
    setRepeat(filled.schedule.type);
    if ("time" in filled.schedule) setTime(filled.schedule.time);
    if (filled.schedule.type === "weekly") setDayOfWeek(filled.schedule.dayOfWeek);
    setError(null);
  }

  const preset = (): SchedulePreset | null => {
    const minuteValue = Number(minute), dayValue = Number(dayOfMonth);
    if (repeat === "manual") return null;
    if (repeat === "once") return { type: "once" };
    if (repeat === "hourly") return Number.isInteger(minuteValue) && minuteValue >= 0 && minuteValue <= 59 ? { type: "hourly", minute: minuteValue } : null;
    if (repeat === "daily" || repeat === "weekdays") return { type: repeat, time };
    if (repeat === "weekly") return { type: "weekly", time, dayOfWeek };
    if (repeat === "monthly") return Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 31 ? { type: "monthly", time, dayOfMonth: dayValue } : null;
    return parseCron(cron) ? { type: "custom", cron } : null;
  };

  async function submit() {
    const chosen = preset();
    const zoneProblem = !isTimeZone(timeZone.trim());
    const problem = !title.trim() ? t("tasks.error.title")
      : kind === "prompt" && !prompt.trim() ? t("tasks.error.prompt")
      : zoneProblem ? t("tasks.error.timeZone")
      : !chosen && repeat !== "manual" ? t(repeat === "custom" ? "tasks.error.cron" : "tasks.error.schedule")
      : chosen?.type === "once" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(runAt) ? t("tasks.error.runAt")
      : null;
    // A problem in a folded field opens it, so the message points at something on screen.
    if (zoneProblem) setAdvanced(true);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      // The template a new task comes from, or the one an existing task keeps.
      const wordingTemplate = task ? task.template : templateId === "dailyBrief" || templateId === "weeklySummary" ? templateId : null;
      const wording = templateWording(wordingTemplate, title.trim(), prompt.trim());
      await onSave({
        kind, title: wording.title, timeZone: timeZone.trim(), catchUp,
        ...(!task && (wordingTemplate === "dailyBrief" || wordingTemplate === "weeklySummary") ? { template: wordingTemplate } : {}),
        ...(kind === "prompt" ? {
          prompt: wording.prompt,
          model: model === DEFAULT_MODEL ? null : parseModelRefValue(model),
          workspaceGrantId: folder === NO_FOLDER ? null : folder,
          approvalRule, usesMemory, notify,
          reasoningEffort: effort === APP_EFFORT ? null : effort as TaskEffort,
        } : {}),
        // A task run only by hand clears both the repeat and the time.
        ...(!chosen ? { cron: null, runAt: null } : chosen.type === "once" ? { runAt } : { cron: cronOfPreset(chosen) }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tasks.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const timed = repeat === "daily" || repeat === "weekdays" || repeat === "weekly" || repeat === "monthly";
  const field = (name: string) => `${id}-${name}`;
  // A stored choice the lists no longer offer is still shown, as what it is, until it is changed.
  const missingModel = model !== DEFAULT_MODEL && choices.models.length > 0 && !choices.models.some(item => modelRefKey(item) === model);
  const missingFolder = folder !== NO_FOLDER && !choices.grants.some(grant => grant.id === folder);
  return (
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="flex flex-col gap-2">
        <label className="sr-only" htmlFor={field("title")}>{t("tasks.field.title")}</label>
        <Input id={field("title")} value={title} maxLength={120} placeholder={t("tasks.field.title")} onChange={event => setTitle(event.target.value)} autoFocus />
        {kind === "prompt" ? <>
          <label className="sr-only" htmlFor={field("prompt")}>{t("tasks.field.prompt")}</label>
          <Textarea id={field("prompt")} className="min-h-28" value={prompt} maxLength={20_000} placeholder={t("tasks.field.promptPlaceholder")} aria-describedby={field("prompt-hint")} onChange={event => setPrompt(event.target.value)} />
          <p id={field("prompt-hint")} className="text-xs text-muted-foreground">{t("tasks.field.promptHint")}</p>
        </> : <p className="text-sm text-muted-foreground">{t(`tasks.kindHint.${kind}`)}</p>}
      </div>

      <div className="form-rows">
        {/* A template only fills in the form. What a task is cannot change once it
            exists: its conversation and history belong to that kind. */}
        {!task ? (
          <Row label={t("tasks.field.template")} htmlFor={field("template")}>
            <SelectField id={field("template")} variant="ghost" size="sm" value={templateId} onValueChange={value => chooseTemplate(value as TaskTemplateId)}>
              {TASK_TEMPLATES.map(value => <SelectOption key={value} value={value}>{t(`tasks.template.${value}`)}</SelectOption>)}
            </SelectField>
          </Row>
        ) : null}
        <Row label={t("tasks.field.repeat")} htmlFor={field("repeat")}>
          <SelectField id={field("repeat")} variant="ghost" size="sm" value={repeat} onValueChange={value => setRepeat(value as Repeat)}>
            {REPEATS.map(value => <SelectOption key={value} value={value}>{t(`tasks.repeat.${value}`)}</SelectOption>)}
          </SelectField>
        </Row>
        {repeat === "once" ? (
          <Row label={t("tasks.field.runAt")}>
            <span className="text-xs text-muted-foreground">{zoneLabel(timeZone)}</span>
            <TaskDateTimeButton label={t("tasks.field.runAt")} value={runAt} onChange={setRunAt} />
          </Row>
        ) : null}
        {repeat === "hourly" ? (
          <Row label={t("tasks.field.minute")} htmlFor={field("minute")}>
            <Input id={field("minute")} inputMode="numeric" className="h-8 w-16 text-right" value={minute} onChange={event => setMinute(event.target.value.replace(/\D/g, "").slice(0, 2))} />
          </Row>
        ) : null}
        {repeat === "weekly" ? (
          <Row label={t("tasks.field.dayOfWeek")} htmlFor={field("weekday")}>
            <SelectField id={field("weekday")} variant="ghost" size="sm" value={dayOfWeek} onValueChange={value => setDayOfWeek(Number(value))}>
              {WEEKDAYS.map(day => <SelectOption key={day} value={String(day)}>{weekdayName(day)}</SelectOption>)}
            </SelectField>
          </Row>
        ) : null}
        {repeat === "monthly" ? (
          <Row label={t("tasks.field.dayOfMonth")} htmlFor={field("day")}>
            <Input id={field("day")} inputMode="numeric" className="h-8 w-16 text-right" value={dayOfMonth} title={t("tasks.field.dayOfMonthHint")} onChange={event => setDayOfMonth(event.target.value.replace(/\D/g, "").slice(0, 2))} />
          </Row>
        ) : null}
        {timed ? (
          <Row label={t("tasks.time")} htmlFor={field("time")}>
            <span className="text-xs text-muted-foreground">{zoneLabel(timeZone)}</span>
            <TimeInput id={field("time")} className="h-8 w-20" value={time} onChange={setTime} />
          </Row>
        ) : null}
        {repeat === "custom" ? (
          <Row label={t("tasks.field.cron")} htmlFor={field("cron")}>
            <Input id={field("cron")} className="h-8 w-44 font-mono" value={cron} maxLength={200} title={t("tasks.field.cronHint")} onChange={event => setCron(event.target.value)} spellCheck={false} />
          </Row>
        ) : null}
      </div>
      {repeat === "custom" ? <p className="-mt-2 text-xs text-muted-foreground">{t("tasks.field.cronHint")}</p> : null}

      <div className="flex flex-col gap-3">
        <button type="button" className="settings-disclosure-trigger flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground" aria-expanded={advanced} aria-controls={field("advanced")} onClick={() => setAdvanced(open => !open)}>
          {t("tasks.field.advanced")}
          <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", advanced && "rotate-180")} />
        </button>
        {advanced ? (
          <div id={field("advanced")} className="flex flex-col gap-2">
            <div className="form-rows">
              {kind === "prompt" ? <>
                <Row label={t("tasks.field.model")} htmlFor={field("model")}>
                  <SelectField id={field("model")} variant="ghost" size="sm" fluid className="max-w-60" value={model} onValueChange={setModel}>
                    <SelectOption value={DEFAULT_MODEL}>{defaultModelName ? `${t("tasks.model.default")} · ${defaultModelName}` : t("tasks.model.default")}</SelectOption>
                    {missingModel && task?.model ? <SelectOption value={model}>{tf("tasks.model.unavailable", { modelId: task.model.modelId })}</SelectOption> : null}
                    {choices.models.map(item => <SelectOption key={modelRefKey(item)} value={modelRefKey(item)}>{item.name}</SelectOption>)}
                  </SelectField>
                </Row>
                <Row label={t("tasks.field.folder")} htmlFor={field("folder")}>
                  <SelectField id={field("folder")} variant="ghost" size="sm" fluid className="max-w-60" value={folder} onValueChange={setFolder}>
                    <SelectOption value={NO_FOLDER}>{t("tasks.folder.none")}</SelectOption>
                    {missingFolder ? <SelectOption value={folder}>{t("tasks.folder.revoked")}</SelectOption> : null}
                    {choices.grants.map(grant => <SelectOption key={grant.id} value={grant.id} title={grant.realPath}>{grant.label}</SelectOption>)}
                  </SelectField>
                </Row>
                <Row label={t("tasks.field.approval")} htmlFor={field("approval")}>
                  <SelectField id={field("approval")} variant="ghost" size="sm" value={approvalRule} onValueChange={value => setApprovalRule(value as ApprovalRule)}>
                    {APPROVAL_RULES.map(rule => <SelectOption key={rule} value={rule}>{t(`approval.rule.${rule}`)}</SelectOption>)}
                  </SelectField>
                </Row>
                <Row label={t("tasks.field.memory")} htmlFor={field("memory")}>
                  <Checkbox id={field("memory")} checked={usesMemory} onCheckedChange={value => setUsesMemory(value === true)} />
                </Row>
                <Row label={t("tasks.field.effort")} htmlFor={field("effort")}>
                  <SelectField id={field("effort")} variant="ghost" size="sm" value={effort} onValueChange={setEffort}>
                    <SelectOption value={APP_EFFORT}>{t("tasks.effort.default")}</SelectOption>
                    {TASK_EFFORTS.map(value => <SelectOption key={value} value={value}>{t(`tasks.effort.${value}`)}</SelectOption>)}
                  </SelectField>
                </Row>
                <Row label={t("tasks.field.notify")} htmlFor={field("notify")}>
                  <SelectField id={field("notify")} variant="ghost" size="sm" value={notify} onValueChange={value => setNotify(value as TaskNotify)}>
                    {TASK_NOTIFY.map(value => <SelectOption key={value} value={value}>{t(`tasks.notifyLevel.${value}`)}</SelectOption>)}
                  </SelectField>
                </Row>
              </> : null}
              {repeat !== "manual" ? <>
                <Row label={t("tasks.field.missed")} htmlFor={field("missed")}>
                  <SelectField id={field("missed")} variant="ghost" size="sm" value={catchUp ? "catchUp" : "skip"} onValueChange={value => setCatchUp(value === "catchUp")}>
                    <SelectOption value="catchUp">{t("tasks.missed.catchUp")}</SelectOption>
                    <SelectOption value="skip">{t("tasks.missed.skip")}</SelectOption>
                  </SelectField>
                </Row>
                <Row label={t("tasks.field.timeZone")} htmlFor={field("zone")}>
                  <Input id={field("zone")} className="h-8 w-44 text-right" value={timeZone} maxLength={100} onChange={event => setTimeZone(event.target.value)} spellCheck={false} />
                </Row>
              </> : null}
            </div>
            {kind === "prompt" ? <p className="text-xs text-muted-foreground">{t(`approval.ruleHint.${approvalRule}`)} {t("tasks.field.approvalHint")}</p> : null}
            {repeat !== "manual" ? <p className="text-xs text-muted-foreground">{t("tasks.field.missedHint")}</p> : null}
          </div>
        ) : null}
      </div>

      <Reveal>{error ? <Alert variant="destructive"><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}</Reveal>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>{t("chat.common.cancel")}</Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" /> : null}
          {task ? t("chat.common.save") : t("tasks.createAction")}
        </Button>
      </div>
    </form>
  );
}
