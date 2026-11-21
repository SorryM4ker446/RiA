export function readEvidence(tool: string, value: unknown) {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (tool === "readProjectFile" && typeof item.grantId === "string" && typeof item.path === "string" && typeof item.hash === "string" && Array.isArray(item.lines) && item.lines.length) {
    const startLine = item.lines[0]?.line, endLine = item.lines.at(-1)?.line;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
    return {
      key: JSON.stringify([tool, item.grantId, item.path, item.hash, item.startLine, startLine, endLine, item.lines.length, item.nextLine ?? null]),
      location: { path: item.path, hash: item.hash, startLine, endLine, nextLine: item.nextLine ?? null },
    };
  }
  if (tool === "readDocument" && typeof item.documentId === "string" && typeof item.contentHash === "string" && typeof item.offset === "number" && Number.isInteger(item.offset) && typeof item.text === "string" && item.text.length) {
    const location = { documentId: item.documentId, contentHash: item.contentHash, offset: item.offset, endOffset: item.offset + item.text.length, nextOffset: item.nextOffset ?? null };
    const exact = createHash("sha256").update(JSON.stringify([item.text, item.pages ?? null])).digest("hex");
    return { key: JSON.stringify([tool, location, exact]), location };
  }
  return null;
}

export function readEvidenceReference(evidence: NonNullable<ReturnType<typeof readEvidence>>, firstCallId: string) {
  return JSON.stringify({ unchanged: true, ...evidence.location, toolCallId: firstCallId, note: "Use the earlier result for this same version and range." });
}
import { createHash } from "node:crypto";

