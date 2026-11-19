import type { ModelMessage } from "ai";
import { z } from "zod";

/*
 * A question the model puts to the user, with options to choose from. Asking
 * pauses the turn the way an approval does, and the answer travels back the
 * same way: the user's choice is the approval's reason, checked against the
 * question before the turn goes on. Skipping is a rejection, whose reason tells
 * the model to decide for itself.
 */

export const ASK_LIMITS = { questions: 3, options: 5, other: 2000 } as const;

export const askOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(60).describe("A few words."),
  description: z.string().trim().max(200).optional().describe("What choosing it means."),
});
export const askQuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(300).describe("The question, ending with a question mark."),
  header: z.string().trim().min(1).max(16).optional().describe("A one-word label, such as Format."),
  options: z.array(askOptionSchema).min(2).max(ASK_LIMITS.options).describe("2 to 5 distinct choices, without an Other choice."),
  multiSelect: z.boolean().optional().describe("Allow choosing several options."),
}).refine(question => new Set(question.options.map(option => option.label)).size === question.options.length, "Option labels must be distinct.");
export const askUserInput = z.strictObject({
  questions: z.array(askQuestionSchema).min(1).max(ASK_LIMITS.questions),
});
export type AskUserInput = z.infer<typeof askUserInput>;

export const askAnswerSchema = z.strictObject({
  answers: z.array(z.strictObject({
    selected: z.array(z.string().max(60)).max(ASK_LIMITS.options),
    other: z.string().trim().max(ASK_LIMITS.other).optional(),
  })).min(1).max(ASK_LIMITS.questions),
});
export type AskAnswer = z.infer<typeof askAnswerSchema>;
export type AskUserOutput = { answers: { question: string; selected: string[]; other?: string }[] };

export const ASK_USER_DESCRIPTION = [
  "Ask the user to choose, with 1 to 3 questions of 2 to 5 short options each; the turn pauses until they answer.",
  "Whether to use it is your judgement; the test is whether the way forward depends on a decision only they can make, and it changes the result: an approach, a format, the scope or the target.",
  "Use it for: \"add a database to this app\" with nothing saying which (SQLite or Postgres changes everything after it); \"write up the findings\" when it could be a one-page note or a full report and nothing says which.",
  "Skip it for: what you can find out yourself (read the file, run the check); what they already said; permission to do what they asked; a small choice with a sensible default (take it and say so).",
  "Put a recommended option first and say so. They can also answer in their own words or skip; if they skip, decide yourself and say what you assumed.",
].join(" ");

/** Why a submitted answer does not fit the question; null when it does. */
export function answerProblem(input: AskUserInput, answer: AskAnswer): string | null {
  if (answer.answers.length !== input.questions.length) return "Answer every question.";
  for (const [index, question] of input.questions.entries()) {
    const given = answer.answers[index];
    const labels = new Set(question.options.map(option => option.label));
    if (given.selected.some(label => !labels.has(label))) return "Choose from the options given.";
    if (!question.multiSelect && given.selected.length > 1) return "Choose one option.";
    if (!given.selected.length && !given.other) return "Answer every question.";
  }
  return null;
}

/** The answer in the approval's reason, checked against the question; null when it is missing or does not fit. */
export function readAnswer(input: unknown, reason: string | undefined): AskUserOutput | null {
  const question = askUserInput.safeParse(input);
  if (!question.success || !reason) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(reason); } catch { return null; }
  const answer = askAnswerSchema.safeParse(parsed);
  if (!answer.success || answerProblem(question.data, answer.data)) return null;
  return { answers: question.data.questions.map((asked, index) => ({
    question: asked.question, selected: answer.data.answers[index].selected,
    ...(answer.data.answers[index].other ? { other: answer.data.answers[index].other } : {}),
  })) };
}

/** The reason the user's approval of this call carried, from the request's messages. */
export function approvalReasonFor(messages: readonly ModelMessage[], toolCallId: string | undefined): string | undefined {
  if (!toolCallId) return undefined;
  let approvalId: string | undefined;
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) if (part.type === "tool-approval-request" && part.toolCallId === toolCallId) approvalId = part.approvalId;
  }
  if (!approvalId) return undefined;
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) if (part.type === "tool-approval-response" && part.approvalId === approvalId) return part.reason;
  }
  return undefined;
}
