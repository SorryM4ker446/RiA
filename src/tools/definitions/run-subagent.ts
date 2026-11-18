import { z } from "zod";

export const RUN_SUBAGENT_DESCRIPTION = [
  "Hand one self-contained piece of work to a sub-agent, which does it with a fresh context and your tools, and returns a report.",
  "Use it for work that takes many steps or much reading whose details you do not need to keep: researching across many documents or pages, examining a large folder, trying several approaches. Call it several times in one step for independent pieces; they run at the same time.",
  "The sub-agent sees nothing of this conversation, so write task as a complete brief: the goal, what you already know, where to look, and what the report should contain.",
  "It cannot ask the user anything, and an action this conversation's approval rule would ask the user about is not run: its report lists such actions, and you do them yourself.",
  "Do not use it for a quick lookup or a single tool call you can make yourself.",
].join(" ");

export const runSubagentInput = z.strictObject({
  title: z.string().trim().min(1).max(80).describe("A few words naming the work, shown to the user."),
  task: z.string().trim().min(1).max(50_000).describe("The complete brief: everything the sub-agent needs, since it sees nothing else."),
});
export type RunSubagentInput = z.infer<typeof runSubagentInput>;
