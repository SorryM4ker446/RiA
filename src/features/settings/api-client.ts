import { getApiErrorMessage } from "@/lib/api-error-message";
import { t } from "@/lib/locale";
export async function settingsRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(getApiErrorMessage(body, t("settingsApi.actFailed")));
  return body as T;
}
export const jsonRequest = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export function downloadBackup(id: string) {
  const anchor = document.createElement("a"); anchor.href = `/api/backups/${encodeURIComponent(id)}?download=1`; anchor.download = ""; document.body.append(anchor); anchor.click(); anchor.remove();
}
