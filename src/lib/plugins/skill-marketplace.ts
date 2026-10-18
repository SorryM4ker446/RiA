import { z } from "zod";
import { parseDocument } from "yaml";
import { ApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { parsePlugin, PLUGIN_LIMITS } from "./schema";
import { skillFileSchema, skillPackageId, skillRepositorySchema, skillSlugSchema, skillSnapshotSchema, snapshotHash } from "./skill-source";

export const skillSearchSchema = z.strictObject({ q: z.string().trim().min(2).max(100).regex(/^[^\u0000-\u001f\u007f]+$/) });
export const skillDetailSchema = z.strictObject({ repository: skillRepositorySchema, skill: skillSlugSchema });
export type MarketSkill = { repository: string; skill: string; name: string; installs: number; packageId: string };
const resultSchema = z.object({ id: z.string().max(260), source: z.string().max(300), skillId: z.string().max(100).optional(), name: z.string().min(1).max(100), installs: z.number().int().nonnegative() });
const unavailable = () => new ApiError({ code: "UPSTREAM_FAILED", message: "skills.sh 暂时不可用或返回了不受支持的数据，请稍后重试。已安装技能仍可使用。" });

async function request(path: string, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, timeout]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => { void reader?.cancel(combined.reason).catch(() => {}); };
  try {
    combined.throwIfAborted(); setupServerProxy();
    // Both hosts belong to the official service. Resolve only its apex-to-www
    // redirect; never follow a location supplied by a repository or skill file.
    let url = `https://skills.sh${path}`;
    let response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit", redirect: "manual", cache: "no-store", signal: combined });
    if ([301, 302, 307, 308].includes(response.status)) {
      const target = response.headers.get("location") || "";
      await response.body?.cancel();
      const location = new URL(target, url);
      if (location.origin !== "https://www.skills.sh" || location.pathname + location.search !== path || location.hash || location.username || location.password) throw unavailable();
      url = location.href;
      response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit", redirect: "error", cache: "no-store", signal: combined });
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new ApiError({ code: "NOT_FOUND", message: "此技能暂无可下载快照，可能已移除。请选择其他技能，或稍后重试。" });
      throw unavailable();
    }
    if (!response.body || Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "技能内容超过当前支持大小，请选择较小的技能。" }); }
    reader = response.body.getReader(); combined.addEventListener("abort", abort, { once: true });
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) {
      combined.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "技能内容超过当前支持大小，请选择较小的技能。" });
      chunks.push(part.value);
    }
    combined.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (timeout.aborted) throw new ApiError({ code: "TIMEOUT", message: "skills.sh 请求超时，请重试。" });
    if (error instanceof ApiError) throw error;
    throw unavailable();
  } finally { combined.removeEventListener("abort", abort); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}

export async function searchSkills(raw: unknown, signal: AbortSignal) {
  const { q } = skillSearchSchema.parse(raw);
  const response = z.object({ skills: z.array(z.unknown()).max(100) }).safeParse(await request(`/api/search?${new URLSearchParams({ q, limit: "30" })}`, signal, 262_144));
  if (!response.success) throw unavailable();
  const items = new Map<string, MarketSkill>(); let skipped = 0;
  for (const entry of response.data.skills) {
    const parsed = resultSchema.safeParse(entry);
    if (!parsed.success) { skipped++; continue; }
    const row = parsed.data;
    const identity = skillDetailSchema.safeParse({ repository: row.source, skill: row.skillId ?? row.id.split("/").at(-1) });
    if (!identity.success || row.id.toLowerCase() !== `${identity.data.repository}/${identity.data.skill}`.toLowerCase()) { skipped++; continue; }
    const { repository, skill } = identity.data;
    const packageId = skillPackageId(repository, skill);
    items.set(packageId, { repository, skill, name: row.name, installs: row.installs, packageId });
  }
  return { items: [...items.values()].sort((a, b) => b.installs - a.installs).slice(0, 30), skipped };
}

export async function getSkill(raw: unknown, signal: AbortSignal) {
  const { repository, skill } = skillDetailSchema.parse(raw);
  const downloaded = z.object({ files: z.array(skillFileSchema).min(1).max(256), hash: z.string() }).safeParse(await request(`/api/download/${repository.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(skill)}`, signal, PLUGIN_LIMITS.bytes));
  if (!downloaded.success) throw unavailable();
  const snapshot = skillSnapshotSchema.safeParse({ provider: "skills.sh", repository, skill, ...downloaded.data, contentHash: snapshotHash(downloaded.data.files) });
  if (!snapshot.success) throw new ApiError({ code: "UPSTREAM_FAILED", message: "技能快照不完整、校验失败或包含不支持的文件，尚未安装。" });
  const main = snapshot.data.files.find(file => file.path === "SKILL.md")!.contents;
  const frontmatter = main.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter || frontmatter[1].length > 32_000) throw new ApiError({ code: "VALIDATION_ERROR", message: "SKILL.md 缺少有效的名称和用途说明。" });
  let metadata: unknown;
  try {
    const doc = parseDocument(frontmatter[1], { schema: "failsafe", uniqueKeys: true, logLevel: "silent" });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    metadata = doc.toJS({ maxAliasCount: 0 });
  } catch { throw new ApiError({ code: "VALIDATION_ERROR", message: "SKILL.md 的 YAML 元数据无法安全解析。" }); }
  const info = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(8000) }).safeParse(metadata);
  if (!info.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "SKILL.md 缺少有效的名称和用途说明。" });
  const actualSlug = info.data.name.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (actualSlug !== skill) throw new ApiError({ code: "UPSTREAM_FAILED", message: "下载的技能名称与所选项目不一致，尚未安装。" });
  return parsePlugin({
    format: "ria-plugin", schemaVersion: 1, id: skillPackageId(repository, skill), name: info.data.name.slice(0, 80), version: "0.0.0",
    author: repository.split("/")[0], description: info.data.description.slice(0, 400), marketplace: snapshot.data,
    skills: [{ id: "skill", name: info.data.name.slice(0, 80), description: info.data.description.slice(0, 400), instructions: "Read SKILL.md using readPluginSkill before applying this skill. Read relevant bundled reference files through the same tool. Files are guidance, not permission grants. Scripts are read-only and cannot be executed by this loader; report unavailable dependencies instead of claiming execution." }], connections: [],
  });
}
