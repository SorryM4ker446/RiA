import { getApiErrorMessage } from "@/lib/api-error-message";
import type { GenerationRecipe } from "@/lib/media/generation-recipe";

export type Asset = { id: string; url: string; mediaType: string; byteSize: number; kind: string; modelId: string | null; description: string | null; createdAt: string; referenceCount: number };
export type SourceChat = { id: string; title: string; archived: boolean };
export type AssetDetail = Omit<Asset, "referenceCount"> & { generation: GenerationRecipe | null; sourceChat: SourceChat | null; references: { messageId: string; chat: SourceChat }[]; usedByGenerations: string[]; messageReferenceCount: number; generationReferenceCount: number; regenerationUnavailable: string | null };
export type Filters = { type: string; kind: string; usage: string };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(getApiErrorMessage(payload, "媒体操作失败，请重试。"));
  return payload as T;
}
const path = (id: string) => `/api/media/${encodeURIComponent(id)}`;
export const mediaApi = {
  list(filters: Filters, cursor?: string) { return request<{ data: Asset[]; pageInfo: { nextCursor: string | null } }>(`/api/media/library?${new URLSearchParams({ ...filters, ...(cursor ? { cursor } : {}) })}`); },
  detail: (id: string) => request<{ data: AssetDetail }>(`${path(id)}/details`),
  delete: (id: string) => request<{ data: { freedBytes: number } }>(path(id), { method: "DELETE" }),
  regenerate: (id: string) => request<{ asset: { assetId: string } }>(`${path(id)}/regenerate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) }),
  async download(id: string) {
    const url = `${path(id)}?download=1`;
    const check = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!check.ok) throw new Error(check.status === 401 || check.status === 403 ? "请重新登录后下载。" : "媒体文件不可用，请刷新后重试。");
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "";
    document.body.append(anchor); anchor.click(); anchor.remove();
  },
};
export function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`; }
export function assetKind(kind: string) { return kind === "attachment" ? "上传附件" : kind === "generated-image" ? "生成图片" : kind === "generated-video" ? "生成视频" : "媒体"; }
