import { db } from "@/db";
import { normalizeLocale, type Locale } from "@/lib/locale";
import { zhCN } from "@/lib/locale/zh-CN";
import { enUS } from "@/lib/locale/en-US";

/*
 * Tasks whose wording comes from a template.
 *
 * A task made from the brief or the summary remembers its template. While its
 * name is empty or its prompt is missing, that part has not been rewritten,
 * and the template's wording in the interface language is used each time the
 * task is shown or run. Nothing stored is reworded; a later change to a
 * template's wording reaches every task still using it.
 */

export const WORDED_TEMPLATES = ["dailyBrief", "weeklySummary"] as const;
export type WordedTemplate = (typeof WORDED_TEMPLATES)[number];

export const isWordedTemplate = (value: string | null | undefined): value is WordedTemplate =>
  (WORDED_TEMPLATES as readonly string[]).includes(value ?? "");

const dictionaries: Record<Locale, Record<string, string>> = { "zh-CN": zhCN, "en-US": enUS };

export function templateWording(template: WordedTemplate, field: "title" | "prompt", locale: Locale): string {
  return dictionaries[locale][`tasks.template.${template}.${field}`];
}

/**
 * The interface language the user last chose. Before they have chosen one
 * here, the desktop passes the language its settings hold when the service
 * starts; failing both, the default.
 */
export async function interfaceLocale(): Promise<Locale> {
  const stored = await db.interfacePreference.findUnique({ where: { id: "local" }, select: { locale: true } }).catch(() => null);
  return normalizeLocale(stored?.locale ?? process.env.RIA_INTERFACE_LOCALE);
}

export async function saveInterfaceLocale(locale: Locale): Promise<void> {
  await db.interfacePreference.upsert({ where: { id: "local" }, create: { id: "local", locale }, update: { locale } });
}

/** A task's name and prompt as they read now: its own where it has them, the template's otherwise. */
export function wordTask<T extends { template: string | null; title: string; prompt: string | null }>(task: T, locale: Locale): T {
  if (!isWordedTemplate(task.template)) return task;
  return {
    ...task,
    title: task.title || templateWording(task.template, "title", locale),
    prompt: task.prompt ?? templateWording(task.template, "prompt", locale),
  };
}
