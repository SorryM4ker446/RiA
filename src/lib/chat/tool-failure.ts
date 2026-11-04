import { InvalidToolInputError, NoSuchToolError } from "ai";
import { t, tf } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";

/**
 * A tool that failed for a reason of its own. The original message is kept because
 * the model reads it to decide what to do next; a person is told only that the tool
 * failed, since an internal message is no use to them.
 */
export class ToolRunError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ToolRunError";
  }
}

/** What the input schema said was wrong: the error nests it a few levels down. */
function inputProblems(error: unknown) {
  let cause = error;
  for (let depth = 0; cause && depth < 4; depth++) {
    const issues = (cause as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      return issues.slice(0, 3).map((issue: { code?: string; message?: string; path?: unknown[] }) =>
        issue.code === "custom" || !issue.path?.length ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
      ).filter(Boolean).join("; ");
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return "";
}

/**
 * What a failure in a turn should say, whatever part of the turn it came from. The
 * stream reports a bad tool call and an unreachable provider the same way, so only
 * what is left once tools are ruled out reads as the provider being unavailable.
 */
export function describeTurnFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (InvalidToolInputError.isInstance(error)) {
    const problems = inputProblems(error);
    return new ApiError({ code: "VALIDATION_ERROR", message: problems ? tf("chat.toolFailure.invalidInputDetail", { detail: problems }) : t("chat.toolFailure.invalidInput") });
  }
  if (NoSuchToolError.isInstance(error)) return new ApiError({ code: "VALIDATION_ERROR", message: tf("chat.toolFailure.noSuchTool", { name: error.toolName }) });
  if (error instanceof ToolRunError) return new ApiError({ code: "INTERNAL_ERROR", message: t("chatState.toolRunFailed") });
  return new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.chat.providerUnavailable") });
}

/**
 * One turn's reader of failures. A refused tool call is reported twice: first as the
 * error itself, then as that error's message alone, and the second report is the one
 * a part keeps. So what the first said is remembered for the second to find.
 */
export function createTurnFailureReader() {
  const refusals = new Map<string, ApiError>();
  return (error: unknown) => {
    const remembered = typeof error === "string" ? refusals.get(error) : undefined;
    if (remembered) return remembered;
    const failure = describeTurnFailure(error);
    if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) refusals.set(error.message, failure);
    return failure;
  };
}
