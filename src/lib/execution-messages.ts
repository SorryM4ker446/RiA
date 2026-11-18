import { t } from "@/lib/locale";

// Shared recovery guidance contains no provider messages or submitted values.
export function executionGuidance(code: string | null): string {
  switch (code) {
    case "CONTEXT_LIMIT": case "context-limit": return t("errors.contextLimit");
    case "BACKGROUND_LIMIT": return t("tasks.error.backgroundLimit");
    case "output-limit": return t("chat.context.outputLimit");
    case "CONFIGURATION_ERROR": return t("execution.guidance.configuration");
    case "FORBIDDEN": case "UNAUTHORIZED": return t("execution.guidance.forbidden");
    case "UPSTREAM_FAILED": case "MODEL_UNAVAILABLE": return t("execution.guidance.upstream");
    case "TIMEOUT": case "ABORTED": return t("execution.guidance.timeout");
    case "SERVICE_UNAVAILABLE": return t("execution.guidance.serviceUnavailable");
    case "INTERRUPTED": case "interrupted-by-restart": return t("execution.guidance.interrupted");
    case "step-budget": case "failure-budget": case "cost-budget": case "deadline-exceeded": return t("execution.guidance.budget");
    case "UNSUPPORTED_KIND": return t("execution.guidance.unsupportedKind");
    default: return t("execution.guidance.other");
  }
}
