"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, Loader2, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { formatDateTime, localizeMessage, t, tf, type MessageKey } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { animateRemoval, removalKey } from "@/lib/ui/removal";

type Note = { line: number; text: string };
type Topic = { id: string; title: string; summary: string; updatedAt: string; notes: Note[] };
type MemoryView = { content: string; revision: number; updatedAt: string | null; topics: Topic[]; unsorted: Note[]; settled: boolean; organizing: boolean };
type Screen = { name: "home" } | { name: "memory" } | { name: "topic"; id: string } | { name: "source" };

const ENDPOINT = "/api/memory/document";
/** Notes come and go while topics are written, so looking for changes stays this unhurried. */
const ORGANIZING_CHECK_MS = 3_000;
const UNSORTED = "unsorted";
const WHOLE_DOCUMENT = "memory-document";
const topicKey = (id: string) => `memory-topic:${id}`;
const shortDate = (value: string) => formatDateTime(value, { month: "short", day: "numeric" });
const fullDate = (value: string) => formatDateTime(value, { year: "numeric", month: "short", day: "numeric" });

/** Line numbers shift whenever a note goes, so a row is known by what it says, and the rows that stay keep their place. */
function withRowKeys(notes: Note[]) {
  const seen = new Map<string, number>();
  return notes.map(note => {
    const repeat = seen.get(note.text) ?? 0;
    seen.set(note.text, repeat + 1);
    return { ...note, rowKey: `memory-note:${repeat}:${note.text}` };
  });
}

function scrollParent(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * What RiA has come to know about you. MEMORY.md is what the model keeps and reads; the
 * topics are the same notes, sorted by the model for a person to look through.
 */
export function YourRia() {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [view, setView] = useState<MemoryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const root = useRef<HTMLElement>(null);
  const changing = useRef(false);
  const lastRead = useRef(0);
  const askedToSort = useRef(false);

  /** Only the latest read counts, and none that was overtaken by a change made since. */
  const load = useCallback(async () => {
    const read = ++lastRead.current;
    const response = await fetch(ENDPOINT, { cache: "no-store" }).catch(() => null);
    if (read !== lastRead.current) return;
    if (response?.ok) {
      const body = await response.json();
      if (read !== lastRead.current) return;
      setView(body.data); setLoadFailed(false);
    } else setLoadFailed(current => current || !response?.ok);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const organizing = Boolean(view?.organizing);
  useEffect(() => {
    if (!organizing) return;
    const timer = setInterval(() => { if (!changing.current) void load(); }, ORGANIZING_CHECK_MS);
    return () => clearInterval(timer);
  }, [organizing, load]);

  const sort = useCallback(async (quietly: boolean) => {
    const read = ++lastRead.current;
    const response = await fetch(ENDPOINT, { method: "POST" }).catch(() => null);
    if (!response?.ok) { if (!quietly) toast(t("settings.yourRia.memory.organizeFailed")); return; }
    const body = await response.json();
    if (read === lastRead.current) setView(body.data);
  }, [toast]);

  // Notes that reached this page unsorted get one try while it is open. A failure leaves them readable, with a way to ask again.
  useEffect(() => {
    if (!view || view.settled || view.organizing || askedToSort.current) return;
    askedToSort.current = true;
    void sort(true);
  }, [view, sort]);

  /** The server decides first; only a change it accepted reaches the screen. */
  async function change(request: () => Promise<Response>, options: { done: MessageKey; failed: MessageKey; removing?: string }) {
    if (!view || changing.current) return false;
    changing.current = true; setBusy(true);
    lastRead.current++;
    try {
      const response = await request();
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast({ title: t(options.failed), description: localizeMessage(getApiErrorMessage(body, t("settings.yourRia.memory.changed"))) });
        await load();
        return false;
      }
      toast(t(options.done));
      const commit = () => flushSync(() => setView(body.data));
      if (options.removing) await animateRemoval(options.removing, commit); else commit();
      return true;
    } catch { toast(t(options.failed)); return false; }
    finally { changing.current = false; setBusy(false); }
  }

  const deleteLines = (lines: number[], options: { done: MessageKey; removing: string }) => change(
    () => fetch(`${ENDPOINT}?revision=${view!.revision}&lines=${lines.join(",")}`, { method: "DELETE" }),
    { ...options, failed: "settings.yourRia.memory.failed" },
  );
  const saveNote = (line: number, text: string) => change(
    () => fetch(ENDPOINT, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: view!.revision, line, text }) }),
    { done: "settings.yourRia.memory.saved", failed: "settings.yourRia.memory.saveFailed" },
  );
  async function deleteTopic(topic: Topic) {
    if (await confirm({ title: tf("settings.yourRia.memory.confirmTopicTitle", { title: topic.title }), description: tf("settings.yourRia.memory.confirmTopicDescription", { count: topic.notes.length }), action: t("settings.yourRia.memory.delete"), destructive: true }))
      await deleteLines(topic.notes.map(note => note.line), { done: "settings.yourRia.memory.topicDeleted", removing: topicKey(topic.id) });
  }
  async function deleteAll() {
    if (await confirm({ title: t("settings.yourRia.memory.confirmTitle"), description: t("settings.yourRia.memory.confirmDescription"), action: t("settings.yourRia.memory.deleteAll"), destructive: true }))
      await change(() => fetch(`${ENDPOINT}?revision=${view!.revision}`, { method: "DELETE" }), { done: "settings.yourRia.memory.allDeleted", failed: "settings.yourRia.memory.failed", removing: WHOLE_DOCUMENT });
  }

  const noteCount = (view?.topics ?? []).reduce((total, topic) => total + topic.notes.length, view?.unsorted.length ?? 0);
  const unsortedTopic = useMemo<Topic | null>(() => view?.unsorted.length ? { id: UNSORTED, title: t("settings.yourRia.memory.unsorted"), summary: "", updatedAt: view.updatedAt ?? "", notes: view.unsorted } : null, [view]);
  // A topic can go while it is open: its last note deleted, or the notes sorted differently. The list is what remains.
  const openTopic = screen.name === "topic" ? [...(view?.topics ?? []), ...(unsortedTopic ? [unsortedTopic] : [])].find(topic => topic.id === screen.id) ?? null : null;
  const shown: Screen = screen.name === "topic" && !openTopic && view ? { name: "memory" } : screen;
  const shownKey = shown.name === "topic" ? `topic:${shown.id}` : shown.name;

  function go(next: Screen, way: "forward" | "back") { setDirection(way); setScreen(next); }

  // A screen that replaces another starts at its top, with the keyboard on its way back.
  const arrived = useRef(shownKey);
  useEffect(() => {
    if (arrived.current === shownKey || !root.current) return;
    arrived.current = shownKey;
    const scroller = scrollParent(root.current);
    if (scroller) scroller.scrollTop = 0;
    root.current.querySelector<HTMLElement>("[data-ria-focus]")?.focus({ preventScroll: true });
  }, [shownKey]);

  const failed = <div className="memory-load-failed"><p>{t("settings.yourRia.memory.loadFailed")}</p><Button type="button" size="sm" variant="ghost" onClick={() => void load()}>{t("settings.yourRia.memory.retry")}</Button></div>;
  const loading = <div className="memory-loading"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>;
  const backTo = (label: string, next: Screen) => <button type="button" className="ria-back" data-ria-focus="" onClick={() => go(next, "back")}><ArrowLeft aria-hidden="true" />{label}</button>;

  let content: ReactNode;
  if (shown.name === "home") {
    const memoryHint = !view ? (loadFailed ? t("settings.yourRia.memory.loadFailed") : "") : !noteCount ? t("settings.yourRia.memory.empty")
      : view.topics.length ? tf("settings.yourRia.memory.count", { topics: view.topics.length, notes: noteCount }) : tf("settings.yourRia.memory.countUnsorted", { notes: noteCount });
    content = <>
      <div className="setting-rows">
        <div className="setting-row">
          <span className="setting-row-label"><span className="ria-entry-title">{t("settings.yourRia.memory.title")}</span><span className="setting-row-hint">{memoryHint || <Skeleton className="h-4 w-32" />}</span></span>
          {view ? <Button type="button" size="sm" variant="secondary" data-ria-focus="" onClick={() => go({ name: "memory" }, "forward")}>{t("settings.yourRia.memory.manage")}</Button>
            : loadFailed ? <Button type="button" size="sm" variant="ghost" onClick={() => void load()}>{t("settings.yourRia.memory.retry")}</Button> : null}
        </div>
        <div className="setting-row">
          <span className="setting-row-label"><span className="ria-entry-title">MEMORY.md</span><span className="setting-row-hint">{t("settings.yourRia.source.description")}</span></span>
          {view ? <Button type="button" size="sm" variant="secondary" onClick={() => go({ name: "source" }, "forward")}>{t("settings.yourRia.source.view")}</Button> : null}
        </div>
      </div>
    </>;
  } else if (shown.name === "memory") {
    content = <>
      {backTo(t("settings.yourRia.title"), { name: "home" })}
      <header className="ria-heading"><h3>{t("settings.yourRia.memory.title")}</h3><p>{t("settings.yourRia.memory.description")}</p></header>
      {!view ? (loadFailed ? failed : loading) : noteCount ? <section aria-label={t("settings.yourRia.memory.topics")}>
        <div className="memory-group-title">
          <span>{t("settings.yourRia.memory.topics")}</span>
          {view.organizing ? <span className="memory-organizing" role="status"><Loader2 aria-hidden="true" className="animate-spin" />{t("settings.yourRia.memory.organizing")}</span>
            : !view.settled ? <Button type="button" size="sm" variant="ghost" className="memory-organize" disabled={busy} onClick={() => void sort(false)}>{t("settings.yourRia.memory.organize")}</Button> : null}
        </div>
        <ul className="item-list">
          {view.topics.map(topic => <li key={topic.id} className="item-row memory-topic" {...removalKey(topicKey(topic.id))}>
            <button type="button" className="item-row-open memory-topic-open" onClick={() => go({ name: "topic", id: topic.id }, "forward")}>
              <span className="memory-topic-title">{topic.title}</span>
              <span className="memory-topic-summary truncate">{topic.summary || topic.notes[0].text}</span>
              <span className="memory-topic-date">{tf("settings.yourRia.memory.updatedOn", { date: shortDate(topic.updatedAt) })}</span>
            </button>
            <Button type="button" size="icon" variant="ghost" className="item-row-action memory-row-icon" disabled={busy} aria-label={tf("settings.yourRia.memory.deleteTopicNamed", { title: topic.title })} onClick={() => void deleteTopic(topic)}><Trash2 aria-hidden="true" /></Button>
          </li>)}
          {unsortedTopic ? <li key={UNSORTED} className="item-row memory-topic">
            <button type="button" className="item-row-open memory-topic-open" onClick={() => go({ name: "topic", id: UNSORTED }, "forward")}>
              <span className="memory-topic-title">{unsortedTopic.title}</span>
              <span className="memory-topic-summary truncate">{unsortedTopic.notes[0].text}</span>
              <span className="memory-topic-date">{tf("settings.yourRia.memory.noteCount", { notes: unsortedTopic.notes.length })}</span>
            </button>
          </li> : null}
        </ul>
      </section> : <p className="empty-state memory-empty">{t("settings.yourRia.memory.empty")}</p>}
    </>;
  } else if (shown.name === "topic") {
    const topic = openTopic;
    content = <>
      {backTo(t("settings.yourRia.memory.title"), { name: "memory" })}
      {!view ? (loadFailed ? failed : loading) : topic ? <>
        <header className="ria-heading ria-heading-row">
          <h3>{topic.title}</h3>
          {topic.id !== UNSORTED ? <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void deleteTopic(topic)}>{t("settings.yourRia.memory.delete")}</Button> : null}
        </header>
        <dl className="memory-facts">
          {topic.updatedAt ? <div><dt>{t("settings.yourRia.memory.lastUpdated")}</dt><dd>{fullDate(topic.updatedAt)}</dd></div> : null}
          {topic.summary ? <div><dt>{t("settings.yourRia.memory.summary")}</dt><dd>{topic.summary}</dd></div> : null}
          <div><dt>{t("settings.yourRia.memory.details")}</dt><dd>
            <ul className="memory-notes">{withRowKeys(topic.notes).map(note => <NoteRow key={note.rowKey} note={note} busy={busy}
              onSave={text => saveNote(note.line, text)}
              onDelete={() => void deleteLines([note.line], { done: "settings.yourRia.memory.deleted", removing: note.rowKey })} />)}</ul>
          </dd></div>
        </dl>
      </> : null}
    </>;
  } else {
    content = <>
      {backTo(t("settings.yourRia.title"), { name: "home" })}
      <header className="ria-heading ria-heading-row">
        <div><h3>MEMORY.md</h3><p>{t("settings.yourRia.source.description")}</p></div>
        {view?.content ? <Button type="button" size="sm" variant="ghost" className="memory-clear" disabled={busy} onClick={() => void deleteAll()}>{t("settings.yourRia.memory.deleteAll")}</Button> : null}
      </header>
      {!view ? (loadFailed ? failed : loading) : view.content ? <pre className="memory-source" tabIndex={0} {...removalKey(WHOLE_DOCUMENT)}>
        {view.content.trimEnd().split("\n").map((line, index) => <span key={index} data-heading={line.startsWith("#") || undefined}>{line}{"\n"}</span>)}
      </pre> : <p className="empty-state memory-empty">{t("settings.yourRia.memory.empty")}</p>}
    </>;
  }

  return <section ref={root} className="settings-section ria-panel">
    <div key={shownKey} className="ria-screen" data-direction={direction}>{content}</div>
  </section>;
}

/** One memory in a topic. A person can reword it or delete it; either goes to MEMORY.md itself. */
function NoteRow({ note, busy, onSave, onDelete }: { note: Note & { rowKey: string }; busy: boolean; onSave: (text: string) => Promise<boolean>; onDelete: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editing = draft !== null;
  // Ahead of the settings dialog, which listens for Escape before React would see it: only the edit is being left.
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.activeElement !== editor.current) return;
      event.stopPropagation();
      if (!event.isComposing) setDraft(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing]);
  async function save() {
    const text = draft?.trim();
    if (!text || busy) return;
    if (text === note.text || await onSave(text)) setDraft(null);
  }
  if (draft !== null) return <li className="memory-note memory-note-editing" {...removalKey(note.rowKey)}>
    <Textarea ref={editor} autoFocus className="min-h-[72px]" maxLength={500} aria-label={t("settings.yourRia.memory.editLine")} value={draft} readOnly={busy}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); }
      }} />
    <div className="memory-note-edit-actions">
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t("settings.yourRia.memory.cancel")}</Button>
      <Button type="button" size="sm" disabled={busy || !draft.trim()} onClick={() => void save()}>{t("settings.yourRia.memory.save")}</Button>
    </div>
  </li>;
  return <li className="memory-note" {...removalKey(note.rowKey)}>
    <span className="memory-note-text">{note.text}</span>
    <span className="memory-note-actions">
      <Button type="button" size="icon" variant="ghost" className="memory-row-icon" disabled={busy} aria-label={t("settings.yourRia.memory.editLine")} onClick={() => setDraft(note.text)}><Pencil aria-hidden="true" /></Button>
      <Button type="button" size="icon" variant="ghost" className="memory-row-icon" disabled={busy} aria-label={t("settings.yourRia.memory.deleteLine")} onClick={onDelete}><X aria-hidden="true" /></Button>
    </span>
  </li>;
}
