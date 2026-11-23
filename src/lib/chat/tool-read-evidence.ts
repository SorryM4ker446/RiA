import { createHash } from "node:crypto";
import { isProjectInstructionFile, type ProjectInstructionFile } from "@/lib/local-files/project-instructions";

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

/** Keep the read's version and location when its full text already travels in AGENTS.md. */
export function projectInstructionReadReference(tool: string, value: unknown, source?: ProjectInstructionFile) {
  if (!source || tool !== "readProjectFile" || !value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.hash !== source.hash || typeof item.grantId !== "string" || typeof item.path !== "string"
    || !isProjectInstructionFile(source, { grantId: item.grantId, path: item.path })) return null;
  const evidence = readEvidence(tool, item);
  if (!evidence) return null;
  return { ...evidence.location, grantId: item.grantId, totalLines: item.totalLines, bytes: item.bytes, eol: item.eol, bom: item.bom,
    note: "Use the AGENTS.md in the prompt when its hash matches this read. Use readConversationHistory for the original result if that version is no longer in the prompt." };
}

