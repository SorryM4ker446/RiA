import type { ModelMessage } from "ai";
import { z } from "zod";

/*
 * The model's checklist for a task of several steps. Each call states the
 * whole list as it now stands, so the latest call is the plan: nothing is kept
 * apart from the call itself, and the conversation shows the newest state.
 */

export const PLAN_LIMITS = { items: 20, characters: 200 } as const;
export const planStatuses = ["pending", "in_progress", "completed"] as const;
export type PlanStatus = (typeof planStatuses)[number];

export const planItemSchema = z.strictObject({
  content: z.string().trim().min(1).max(PLAN_LIMITS.characters).describe("The step, a short imperative phrase."),
  status: z.enum(planStatuses),
});
export type PlanItem = z.infer<typeof planItemSchema>;

export const updatePlanInput = z.strictObject({
  items: z.array(planItemSchema).min(1).max(PLAN_LIMITS.items).describe("The whole checklist, in order."),
}).refine(input => input.items.filter(item => item.status === "in_progress").length <= 1, "At most one step can be in_progress at a time.");
export type UpdatePlanInput = z.infer<typeof updatePlanInput>;

export const UPDATE_PLAN_DESCRIPTION = [
  "Show the user a checklist of the work ahead and keep it current, so they can follow progress on work they are waiting for. Whether to use it is your judgement; the test is whether the user would want to see where you are.",
  "Use it when the work will take a while or many tool calls (changes across several files, a build-test-fix loop, an investigation in stages) or when the user gave several separate things to do. Skip it when a few quick actions finish the job, for a single answer or for conversation: there it only adds noise.",
  "Use it for: \"add validation to the signup form, write tests, run the suite and fix what fails\" (write, test, fix: the user waits through it); \"rename this setting everywhere and update the docs\" (many files); \"summarise each of these three reports\" (several requests).",
  "Skip it for: \"create notes.md with a heading\" (one quick action); \"why does this test fail?\" before any work is decided (an answer).",
  "Write it before starting; mark a step in_progress just before working on it and completed as soon as it is done. Each call gives the whole list as it stands, with at most one in_progress; add or drop steps as the work changes.",
  "Work you hand to several sub-agents at once is one step (such as \"check the three services\"), since only one step can be in_progress; sub-agents cannot update the checklist, so you keep it current as their reports come back.",
].join(" ");

/** What the model is told back: where the plan stands. */
export function planProgress(input: UpdatePlanInput) {
  const completed = input.items.filter(item => item.status === "completed").length;
  return { completed, total: input.items.length, current: input.items.find(item => item.status === "in_progress")?.content ?? null };
}

/** The latest checklist among a message's tool parts, if it has one. */
export function latestPlan(parts: readonly unknown[]): PlanItem[] | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] as { type?: unknown; input?: unknown };
    if (part?.type !== "tool-updatePlan") continue;
    const parsed = z.object({ items: z.array(planItemSchema) }).safeParse(part.input);
    if (parsed.success && parsed.data.items.length) return parsed.data.items;
  }
  return null;
}

/** How many tool calls in a turn before a reminder about the checklist, and between reminders. */
export const PLAN_REMINDER = { firstAfterCalls: 5, everyCalls: 5 } as const;
type Call = { toolName: string; input: unknown };

/*
 * A short note for the next model step, the way a reminder reaches an agent
 * mid-task: whether to keep a checklist stays the model's call, but a long turn
 * without one is pointed out, and a checklist left behind by the work is shown
 * back so finished steps get ticked. Worked out from the step's own messages:
 * a note goes out only on the step where the turn's calls cross a multiple of
 * the interval, so it is not repeated every step, and nothing is stored.
 */
export function planReminder(messages: readonly ModelMessage[]): string | null {
  let start = 0;
  messages.forEach((message, index) => { if (message.role === "user") start = index + 1; });
  const turn = messages.slice(start);
  const lastAssistant = turn.map(message => message.role).lastIndexOf("assistant");
  const callsIn = (list: readonly ModelMessage[]): Call[] => list.flatMap(message =>
    message.role === "assistant" && typeof message.content !== "string" ? message.content.flatMap(part => part.type === "tool-call" ? [{ toolName: part.toolName, input: part.input }] : []) : []);
  const calls = callsIn(turn), before = callsIn(lastAssistant >= 0 ? turn.slice(0, lastAssistant) : turn);
  // Which reminder a count has reached (-1: none yet); a note goes out when this step reached a new one.
  const reached = (count: number, first: number, every: number) => count < first ? -1 : Math.floor((count - first) / every);
  const crossed = (now: number, then: number, first: number, every: number) => reached(now, first, every) > reached(then, first, every);
  const lastPlan = calls.map(call => call.toolName).lastIndexOf("updatePlan");
  if (lastPlan < 0) {
    if (!crossed(calls.length, before.length, PLAN_REMINDER.firstAfterCalls, PLAN_REMINDER.everyCalls)) return null;
    return `Note from RiA, not from the user: this turn has made ${calls.length} tool calls without a checklist. If the remaining work is substantial, show the user your plan with updatePlan; if it is nearly done, carry on.`;
  }
  const parsed = updatePlanInput.safeParse(calls[lastPlan].input);
  if (!parsed.success || parsed.data.items.every(item => item.status === "completed")) return null;
  const since = calls.length - lastPlan - 1, sinceBefore = Math.max(0, before.length - lastPlan - 1);
  if (!crossed(since, sinceBefore, PLAN_REMINDER.everyCalls, PLAN_REMINDER.everyCalls)) return null;
  const mark = { completed: "x", in_progress: ">", pending: " " } as const;
  return [
    `Note from RiA, not from the user: your checklist as last updated, ${since} tool calls ago. Mark finished steps completed and the current one in_progress with updatePlan.`,
    ...parsed.data.items.map(item => `- [${mark[item.status]}] ${item.content}`),
  ].join("\n");
}
