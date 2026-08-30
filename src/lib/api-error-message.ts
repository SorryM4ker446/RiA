/** Accept both JSON responses and the serialized error text used by AI SDK streams. */
export function getApiErrorMessage(payload: unknown, fallback = "请求失败，请稍后重试。"): string {
  if (typeof payload === "string") {
    try { return getApiErrorMessage(JSON.parse(payload), fallback); }
    catch { return payload || fallback; }
  }
  if (!payload || typeof payload !== "object" || !("error" in payload)) return fallback;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("message" in error) || typeof error.message !== "string") return fallback;
  if ("code" in error && error.code === "RATE_LIMITED" && "details" in error && error.details && typeof error.details === "object" && "retryAfterSeconds" in error.details && typeof error.details.retryAfterSeconds === "number") {
    return `${error.message}（约 ${Math.max(1, Math.ceil(error.details.retryAfterSeconds))} 秒后可重试）`;
  }
  if ("code" in error && error.code === "CONFLICT") return `${error.message}。请重新加载会话以查看最新内容。`;
  return error.message;
}
