import { z } from "zod";
import { createTask as saveTask } from "@/lib/scheduler/jobs";
import { isTimeZone, parseCron } from "@/lib/scheduler/cron";

export const createTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1, "title is required").max(120).describe("A short name for the task, as the user would recognise it in a list."),
  prompt: z.string().trim().min(1, "prompt is required").max(20_000).describe("What to do each time the task runs, written as a complete instruction. The run happens later in the task's own conversation, which sees nothing of this one, so include everything it needs."),
  cron: z.string().trim().max(200).refine(value => parseCron(value) !== null, "cron must be five fields: minute hour day-of-month month day-of-week").optional()
    .describe("For a task that repeats: a five-field cron expression read in timeZone, such as \"0 9 * * 1-5\" for 09:00 on weekdays. Leave out for a task that runs once."),
  runAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "runAt must be a local date and time written YYYY-MM-DDTHH:mm").optional()
    .describe("For a task that runs once: the local date and time in timeZone, as YYYY-MM-DDTHH:mm. Leave out for a task that repeats."),
  timeZone: z.string().max(100).refine(isTimeZone, "Invalid IANA time zone").describe("The IANA time zone the schedule is read in, such as Asia/Shanghai."),
}).superRefine((value, context) => {
  if (Boolean(value.cron) === Boolean(value.runAt)) context.addIssue({ code: "custom", message: "Give either cron for a repeating task or runAt for one that runs once", path: ["cron"] });
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export type CreateTaskOutput = {
  taskId: string;
  title: string;
  prompt: string;
  cron: string | null;
  timeZone: string;
  nextRunAt: string;
  enabled: boolean;
};

/** The user approved this task as it stands, so it is created switched on. */
export async function createTask(input: CreateTaskInput): Promise<CreateTaskOutput> {
  const task = await saveTask({ kind: "prompt", title: input.title, prompt: input.prompt, enabled: true, cron: input.cron ?? null, runAt: input.runAt ?? null, timeZone: input.timeZone });
  // The tool always names a repeat or a time, so the task has a next run.
  return { taskId: task.id, title: task.title, prompt: task.prompt ?? input.prompt, cron: task.cron, timeZone: task.timeZone, nextRunAt: task.nextRunAt!, enabled: task.enabled };
}
