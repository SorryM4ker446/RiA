"use client";
import { useLocale } from "@/lib/locale/client";
import { formatDateTime, localizeMessage, t, tf } from "@/lib/locale";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Check, ChevronRight, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { conversationState, useConversationStore } from "@/features/chat/conversation-store";
import { conversationHref, openConversationFromHref } from "@/features/chat/open-conversation";
import { sendChatCommand } from "@/features/commands/chat-commands";
import { useOpenSettings } from "@/features/settings/settings-context";
import { taskTitle, type TaskView } from "@/features/tasks/task-client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

type Notice = { id: string; kind: string; title: string; detail: string | null; href: string | null; createdAt: string; readAt: string | null };

/** Recent conversations offered under the question box. */
const RECENT_PILLS = 3;
/** Today's tasks shown in the line at the foot of the page before "N more". */
const TIMELINE_ITEMS = 4;
const RAN_LABEL: Record<string, Parameters<typeof t>[0]> = { done: "home.today.ran.done", failed: "home.today.ran.failed", running: "home.today.ran.running", waiting_approval: "home.today.ran.waiting_approval", skipped: "home.today.ran.skipped", missed: "home.today.ran.missed", interrupted: "home.today.ran.interrupted" };

function greeting(hour: number) {
  return t(hour < 11 ? "home.today.greeting.morning" : hour < 13 ? "home.today.greeting.noon" : hour < 18 ? "home.today.greeting.afternoon" : "home.today.greeting.evening");
}
const sameDay = (iso: string | null, day: Date) => {
  if (!iso) return false;
  const date = new Date(iso);
  return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate();
};
const clock = (iso: string) => formatDateTime(new Date(iso), { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Home: a greeting and a place to ask, at the centre. What else matters today is said in passing:
 * one line under the greeting for what waits on you (its items open from it), the latest
 * conversations as small pills, and today's tasks as a quiet line at the foot of the page.
 */
export default function HomePage() {
  useLocale();
  const router = useRouter();
  const store = useConversationStore();
  const openSettings = useOpenSettings();
  const [now] = useState(() => new Date());
  const [question, setQuestion] = useState("");
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const request = useRef<AbortController | null>(null);

  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const read = async <T,>(url: string, pick: (payload: { data: unknown }) => T): Promise<T | null> => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        return response.ok ? pick(await response.json()) : null;
      } catch { return null; }
    };
    const [models, taskList, noticeList] = await Promise.all([
      read("/api/models", payload => Boolean((payload.data as { chat?: { model?: unknown } })?.chat?.model)),
      read("/api/tasks", payload => (payload.data as TaskView[]) ?? []),
      read("/api/notices", payload => ((payload.data as { notices?: Notice[] })?.notices ?? []).filter(notice => !notice.readAt)),
    ]);
    if (controller.signal.aborted) return;
    if (models !== null) setHasModel(models);
    if (taskList) setTasks(taskList);
    if (noticeList) setNotices(noticeList);
  }
  useEffect(() => {
    void load();
    // A run starting or ending, a task changed elsewhere: the service says so, and the page reads again.
    const stop = store.onChanged(() => void load());
    return () => { stop(); request.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once
  }, [store.onChanged]);
  useRefreshOnReturn(() => load());

  const openChat = (id: string) => { openConversationFromHref(conversationHref(id)); router.push("/chat"); };
  const openTask = (task: TaskView) => task.chatId ? openChat(task.chatId) : router.push("/tasks");
  function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || !hasModel) return;
    setQuestion("");
    sendChatCommand({ type: "ask", text }, { onChatPage: false, navigate: href => router.push(href) });
  }
  function openNotice(notice: Notice) {
    setNotices(current => current.filter(item => item.id !== notice.id));
    void fetch(`/api/notices/${notice.id}`, { method: "PATCH" }).catch(() => {});
    if (!notice.href) return;
    if (openConversationFromHref(notice.href)) router.push("/chat"); else router.push(notice.href);
  }

  const states = store.chats.map(chat => ({ chat, state: conversationState(chat, store.workingId, null) }));
  const approvals = states.filter(item => item.state === "approval").map(item => item.chat);
  const recent = states.filter(item => item.state !== "approval")
    .sort((a, b) => Number(Boolean(b.state)) - Number(Boolean(a.state)) || Date.parse(b.chat.lastMessageAt) - Date.parse(a.chat.lastMessageAt))
    .slice(0, RECENT_PILLS);
  const failedTasks = tasks.filter(task => task.lastStatus === "failed" && task.lastRunAt && now.getTime() - Date.parse(task.lastRunAt) < 86_400_000);
  const waiting = approvals.length + failedTasks.length + notices.length;
  const ranToday = tasks.filter(task => sameDay(task.lastRunAt, now) && !(task.enabled && sameDay(task.nextRunAt, now)));
  const dueToday = tasks.filter(task => task.enabled && sameDay(task.nextRunAt, now));
  const timeline = [...ranToday.map(task => ({ task, at: task.lastRunAt!, ran: true })), ...dueToday.map(task => ({ task, at: task.nextRunAt!, ran: false }))]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const tasksPart = dueToday.length ? tf("home.today.tasksLeft", { count: dueToday.length }) : ranToday.length ? t("home.today.tasksDone") : null;

  return (
    <main className="home">
      <div className="home-center">
        <header className="home-hello">
          <span className="home-star" aria-hidden="true" />
          <h1>{greeting(now.getHours())}</h1>
          {/* One sentence for the day: what waits on you (it opens the list), and what the tasks still have to do. */}
          <p className="home-summary">
            {waiting ? (
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="home-waiting"><span className="home-waiting-dot" aria-hidden="true" />{tf("home.today.needsCount", { count: waiting })}</button>
                </PopoverTrigger>
                <PopoverContent align="center" sideOffset={8} className="home-waiting-list" aria-label={t("home.today.needsYou")}>
                  <ul>
                    {approvals.map(chat => <li key={`approval:${chat.id}`}><button type="button" onClick={() => openChat(chat.id)}><span className="home-item-title">{chat.title}</span><span className="home-item-note">{t("home.today.approval")}</span></button></li>)}
                    {failedTasks.map(task => <li key={`failed:${task.id}`}><button type="button" onClick={() => openTask(task)}><span className="home-item-title">{taskTitle(task)}</span><span className="home-item-note" data-tone="danger">{task.lastError ? localizeMessage(task.lastError) : t("home.today.taskFailed")}</span></button></li>)}
                    {notices.map(notice => <li key={`notice:${notice.id}`}><button type="button" onClick={() => openNotice(notice)}><span className="home-item-title">{notice.title}</span>{notice.detail ? <span className="home-item-note">{notice.detail}</span> : null}</button></li>)}
                  </ul>
                </PopoverContent>
              </Popover>
            ) : null}
            {waiting && tasksPart ? <span aria-hidden="true">·</span> : null}
            {tasksPart ? <span>{tasksPart}</span> : null}
            {!waiting && !tasksPart ? <time dateTime={now.toISOString()}>{formatDateTime(now, { month: "long", day: "numeric", weekday: "long" })}</time> : null}
          </p>
        </header>

        {hasModel === false ? (
          <div className="home-setup" role="note">
            <span>{t("home.today.noModel")}</span>
            <Button size="sm" onClick={() => openSettings("models")}>{t("home.today.addModel")}</Button>
          </div>
        ) : (
          <form className="home-ask" onSubmit={ask}>
            <input aria-label={t("home.today.askLabel")} placeholder={t("home.today.askPlaceholder")} value={question} maxLength={8000} enterKeyHint="send"
              onChange={event => setQuestion(event.target.value)} />
            <Button type="submit" size="icon" aria-label={t("home.today.send")} disabled={!question.trim() || !hasModel}><ArrowUp aria-hidden="true" /></Button>
          </form>
        )}

        {/* Everything under the question box shares the lower half, so the box itself stays at the page's centre. */}
        <div className="home-below">
        {recent.length ? (
          <nav className="home-recent" aria-label={t("home.today.recent")}>
            {recent.map(({ chat, state }) => (
              <button key={chat.id} type="button" className="home-pill" data-state={state ?? undefined} onClick={() => openChat(chat.id)}>
                {state ? <span className="home-pill-dot" aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
                <span className="truncate">{chat.title}</span>
              </button>
            ))}
            <button type="button" className="see-all-link" onClick={() => router.push("/conversations")}>{t("home.today.allConversations")}<ChevronRight aria-hidden="true" /></button>
          </nav>
        ) : null}

      {timeline.length ? (
        <section className="home-day" aria-label={t("home.today.today")}>
          {timeline.slice(0, TIMELINE_ITEMS).map(({ task, at, ran }, index) => [
            index ? <span key={`sep:${index}`} className="home-day-sep" aria-hidden="true" /> : null,
            <button key={`${task.id}:${ran ? "ran" : "next"}`} type="button" className="home-day-item" onClick={() => openTask(task)}>
              <time dateTime={at}>{clock(at)}</time>
              <span className="truncate">{taskTitle(task)}</span>
              {ran && task.lastStatus === "done" ? <Check className="home-day-done" aria-label={t(RAN_LABEL.done)} /> : null}
              {ran && task.lastStatus === "failed" ? <X className="home-day-failed" aria-label={t(RAN_LABEL.failed)} /> : null}
              {ran && task.lastStatus && !["done", "failed"].includes(task.lastStatus) && RAN_LABEL[task.lastStatus] ? <span className="home-day-note">{t(RAN_LABEL[task.lastStatus])}</span> : null}
            </button>,
          ])}
          {timeline.length > TIMELINE_ITEMS ? <button type="button" className="see-all-link" onClick={() => router.push("/tasks")}>{tf("home.today.more", { count: timeline.length - TIMELINE_ITEMS })}<ChevronRight aria-hidden="true" /></button> : null}
        </section>
      ) : null}
        </div>
      </div>
    </main>
  );
}
