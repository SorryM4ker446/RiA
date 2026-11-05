import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Topics are a way to look through MEMORY.md, and only that: they are worked out from
 * the notes, never sent to a model as memory, and joined to the document whenever they
 * are read. So a topic can be out of date, but it cannot show a note that is not there
 * or keep one from view: a note no topic holds is simply not sorted yet.
 */

export type MemoryNote = { line: number; text: string };
export type StoredTopic = { id: string; title: string; summary: string; notes: string[]; updatedAt: string };
export type MemoryTopic = { id: string; title: string; summary: string; updatedAt: string; notes: MemoryNote[] };
export type TopicReply = { id?: string; title: string; summary: string; lines: number[] };

export const MAX_TOPIC_TITLE = 60, MAX_TOPIC_SUMMARY = 300;

const storedSchema = z.array(z.object({ id: z.string(), title: z.string(), summary: z.string(), notes: z.array(z.string()), updatedAt: z.string() }));

export function readStoredTopics(raw: string | null | undefined): StoredTopic[] {
  try { return storedSchema.parse(JSON.parse(raw ?? "[]")); } catch { return []; }
}

/**
 * The notes as their topics hold them. A topic that lost a note, or whose summary is
 * blank, is not settled: its summary may speak of what has gone, so it is not shown.
 */
export function viewTopics(notes: MemoryNote[], stored: StoredTopic[]) {
  const free = new Map<string, MemoryNote[]>();
  for (const note of notes) free.set(note.text, [...(free.get(note.text) ?? []), note]);
  let settled = true;
  const topics = stored.flatMap((topic): MemoryTopic[] => {
    const held = topic.notes.flatMap(text => {
      const note = free.get(text)?.shift();
      return note ? [note] : [];
    });
    if (held.length !== topic.notes.length) settled = false;
    if (!held.length) return [];
    const summary = held.length === topic.notes.length ? topic.summary : "";
    if (!summary) settled = false;
    return [{ id: topic.id, title: topic.title, summary, updatedAt: topic.updatedAt, notes: held }];
  });
  const unsorted = [...free.values()].flat().sort((a, b) => a.line - b.line);
  return { topics, unsorted, settled: settled && !unsorted.length };
}

/**
 * The topics once a document holds only these notes. What a person deleted leaves here
 * at the same moment it leaves the document, along with any summary that may mention it.
 */
export function pruneStoredTopics(stored: StoredTopic[], noteTexts: string[]): StoredTopic[] {
  const free = new Map<string, number>();
  for (const text of noteTexts) free.set(text, (free.get(text) ?? 0) + 1);
  return stored.flatMap(topic => {
    const notes = topic.notes.filter(text => {
      const left = free.get(text) ?? 0;
      if (!left) return false;
      free.set(text, left - 1);
      return true;
    });
    if (!notes.length) return [];
    return [notes.length === topic.notes.length ? topic : { ...topic, notes, summary: "" }];
  });
}

/** A note reworded by a person stays in its topic. The summary is written again, since it may say the old thing. */
export function renameStoredNote(stored: StoredTopic[], from: string, to: string): StoredTopic[] {
  let done = false;
  return stored.map(topic => {
    if (done || !topic.notes.includes(from)) return topic;
    done = true;
    return { ...topic, summary: "", notes: topic.notes.map(text => text === from ? to : text) };
  });
}

/**
 * Turns a model's reply into topics, holding it to the notes that exist. A line it did
 * not know or already placed is ignored, so what it says can only arrange the notes. A
 * topic keeps its date unless what it says or holds changed.
 */
export function topicsFromReply(reply: TopicReply[], notes: MemoryNote[], previous: StoredTopic[], now = new Date()): StoredTopic[] {
  const byLine = new Map(notes.map(note => [note.line, note]));
  const placed = new Set<number>();
  const ids = new Set<string>();
  return reply.flatMap(item => {
    const held = item.lines.flatMap(line => {
      const note = byLine.get(line);
      if (!note || placed.has(line)) return [];
      placed.add(line);
      return [note.text];
    });
    const title = item.title.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_TITLE);
    if (!held.length || !title) return [];
    const earlier = item.id && !ids.has(item.id) ? previous.find(topic => topic.id === item.id) : undefined;
    const id = earlier?.id ?? randomUUID();
    ids.add(id);
    const summary = item.summary.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_SUMMARY);
    const same = earlier && earlier.title === title && earlier.summary === summary && earlier.notes.length === held.length && earlier.notes.every(text => held.includes(text));
    return [{ id, title, summary, notes: held, updatedAt: same ? earlier.updatedAt : now.toISOString() }];
  });
}
