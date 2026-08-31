import { getApiErrorMessage } from "@/lib/api-error-message";
import type { ChatSummary } from "@/features/chat/page-utils";

export type Conversation = ChatSummary & { pinned: boolean; archived: boolean; tags: string[] };
export type Filters = { q: string; tag: string; state: "active" | "archived" | "all" };
export type ConversationPage = { data: Conversation[]; pageInfo: { nextCursor: string | null } };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(getApiErrorMessage(payload, "会话操作失败，请重试。"));
  return payload as T;
}
const path = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
const body = (method: string, value: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

export const conversationsApi = {
  list(filters: Filters, cursor?: string) {
    const query = new URLSearchParams({ state: filters.state });
    if (filters.q.trim()) query.set("q", filters.q.trim());
    if (filters.tag.trim()) query.set("tag", filters.tag.trim());
    if (cursor) query.set("cursor", cursor);
    return request<ConversationPage>(`/api/conversations?${query}`);
  },
  update: (id: string, value: { pinned?: boolean; archived?: boolean; tags?: string[] }) => request<{ data: Conversation }>(path(id), body("PATCH", value)),
  delete: (ids: string[]) => request<{ data: { deletedCount: number } }>("/api/conversations/bulk-delete", body("POST", { ids, confirm: true })),
  async download(id: string, format: "json" | "markdown") {
    const response = await fetch(`${path(id)}/export?${new URLSearchParams({ format })}`, { cache: "no-store" });
    if (!response.ok) throw new Error(getApiErrorMessage(await response.json().catch(() => null), "导出失败，请重试。"));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = response.headers.get("content-disposition")?.match(/filename="(conversation-[a-f0-9]+\.(?:json|md))"/)?.[1] ?? `conversation.${format === "json" ? "json" : "md"}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Allow the browser and Electron download handler to consume the object URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
};
