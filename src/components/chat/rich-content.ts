"use client";
import { useEffect, useSyncExternalStore } from "react";

/*
 * The heavier parts of rendering an answer (code highlighting, formulas,
 * diagrams) load on first need, once, and only on the reader's side: an answer
 * without code, a formula or a diagram never pays for them.
 */

type Lazy<T> = { get: () => T | null; load: () => Promise<T>; subscribe: (listener: () => void) => () => void };

function lazy<T>(importer: () => Promise<T>): Lazy<T> {
  let value: T | null = null, pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    load: () => (pending ??= importer().then(result => { value = result; for (const listener of listeners) listener(); return result; }, error => { pending = null; throw error; })),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const highlighter = lazy(() => import("highlight.js/lib/common").then(module => module.default));
export const mathPlugins = lazy(() => import("./math-runtime").then(module => module.mathRuntime));

/** The loaded library, or null until it is; asks for it only while wanted. */
export function useLazy<T>(source: Lazy<T>, wanted: boolean): T | null {
  const value = useSyncExternalStore(source.subscribe, source.get, () => null);
  useEffect(() => { if (wanted && !value) void source.load().catch(() => {}); }, [source, wanted, value]);
  return wanted ? value : null;
}

/** The text outside fenced code and inline code, where formulas can be. */
function prose(text: string, replace: (part: string) => string) {
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part : replace(part)).join("");
}

/** Whether a block holds a formula: $…$, $$…$$, \(…\) or \[…\] outside code. */
export function hasMath(text: string) {
  let found = false;
  prose(text, part => { if (/\$[^$\n]+\$|\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(part)) found = true; return part; });
  return found;
}

/*
 * Formulas as the math parser reads them. \(…\) and \[…\], which models often
 * write, become $…$ and a $$ block. A dollar sign before a number is a price unless
 * what follows it up to the next dollar sign looks like a formula, so
 * "$5 and $10" stays text while "$2x+1$" is a formula.
 */
export function prepareMath(text: string) {
  return prose(text, part => part
    // A displayed formula is a block of its own: $$ on lines by themselves.
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, body: string) => `$${body}$`)
    .replace(/(?<![\\$])\$(?=\d)([^$\n]*)/g, (match, body: string) => /[\\^_{}=+*/<>]|\d\s*-\s*\d/.test(body) ? match : `\\$${body}`));
}
