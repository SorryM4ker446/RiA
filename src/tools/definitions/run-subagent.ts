import { z } from "zod";

export const RUN_SUBAGENT_DESCRIPTION = [
  "Hand one self-contained piece of work to a sub-agent, which does it with a fresh context and your tools, and returns a report to you. Whether to use it is your judgement; the test is whether the work can be written up as a brief and is either heavy enough that its details would crowd your own context, or something the user wants done apart from you: split up, run side by side, or kept out of the way while the conversation goes on.",
  "Use it for: \"go through these forty log files and find what failed first\" (much reading whose details you will not need); \"find the worst error in svc-auth, svc-billing and svc-search\" (independent pieces: one call each, at the same time); \"have this checked properly while we talk about the design\" or \"split this up and do the parts in parallel\" (the user wants it handed off; in the background when they want to carry on meanwhile).",
  "Skip it for: \"what is in config.json?\" (one read you can do); \"fix this typo\" (one quick edit); a question you can answer from what you already have; work that has to ask the user along the way; and a question about sub-agents themselves, such as what they are or whether RiA has them, which is not a request to start one.",
  "Call it several times in one step for independent pieces; they run at the same time.",
  "The sub-agent sees nothing of this conversation, so write task as a complete brief: the goal, what you already know, where to look, what the report should contain, and whether it should change anything (edit files, run commands that change things) or only look and report.",
  "It cannot ask the user anything, and an action this conversation's approval rule would ask the user about is not run: its report lists such actions, and you do them yourself.",
  "It cannot see or update your checklist: if you keep one with updatePlan, mark the step in_progress before handing it off, and update the checklist as soon as the report comes back.",
  "The report comes back to you, not to the user, who sees it only by opening the run record: tell the user what it found or did in your answer.",
  "By default you wait for the report, which suits work whose result you need before you can go on. Set background to true when you have other work to do meanwhile, or the work is long and the user should not have to wait: you get its id at once and carry on. Its report reaches you by itself when it ends, before your next step if you are still working, or in a new turn of its own once you have finished. Do not wait, sleep or poll for it; checkSubagents shows its status or reads its report again only when you need to.",
].join(" ");

export const CHECK_SUBAGENTS_DESCRIPTION = [
  "Shows this conversation's sub-agents: each one's id, title, status, how long it has run and what it is doing now.",
  "With an id, also gives that one's report and the actions it did not run, once it has ended.",
  "You do not need it to receive a background sub-agent's report, which reaches you by itself; use it only to check on one, or to read again a report from an earlier turn.",
].join(" ");

export const checkSubagentsInput = z.strictObject({
  id: z.string().trim().min(1).max(40).optional().describe("One sub-agent's id, to read its report as well."),
});

export const runSubagentInput = z.strictObject({
  title: z.string().trim().min(1).max(80).describe("A few words naming the work, shown to the user."),
  task: z.string().trim().min(1).max(50_000).describe("The complete brief: everything the sub-agent needs, since it sees nothing else."),
  background: z.boolean().optional().describe("true to carry on while it works; its report comes to you by itself when it ends."),
});
export type RunSubagentInput = z.infer<typeof runSubagentInput>;
