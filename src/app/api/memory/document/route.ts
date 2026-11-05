import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { clearMemoryDocument, deleteMemoryLines, memoryNotes, MAX_LINE_CHARACTERS, readMemoryDocument, replaceMemoryLine } from "@/lib/memory/document";
import { readStoredTopics, viewTopics } from "@/lib/memory/topic-view";
import { memoryTopicsRunning, scheduleMemoryTopics } from "@/lib/memory/topics";
import { readJsonBody } from "@/lib/server/request-body";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";

const deleteSchema = z.strictObject({
  revision: z.coerce.number().int().nonnegative(),
  lines: z.string().regex(/^[1-9]\d*(,[1-9]\d*){0,199}$/).transform(value => value.split(",").map(Number)).optional(),
});
const replaceSchema = z.strictObject({ revision: z.number().int().nonnegative(), line: z.number().int().positive(), text: z.string().trim().min(1).max(MAX_LINE_CHARACTERS) });

type MemoryDocumentRow = Awaited<ReturnType<typeof readMemoryDocument>>;

function view(document: MemoryDocumentRow) {
  const { topics, unsorted, settled } = viewTopics(memoryNotes(document.content), readStoredTopics(document.topics));
  return { content: document.content, revision: document.revision, updatedAt: document.updatedAt, topics, unsorted, settled, organizing: memoryTopicsRunning() };
}

/** After a person's change: what they deleted is already gone, and this writes the summaries that spoke of it. */
function afterChange(document: MemoryDocumentRow) {
  if (!viewTopics(memoryNotes(document.content), readStoredTopics(document.topics)).settled) scheduleMemoryTopics();
  return view(document);
}

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    return Response.json({ data: view(await readMemoryDocument()) });
  } catch (error) {
    console.error("/api/memory/document GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to read the memory document");
  }
}

async function PATCHHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    const { revision, line, text } = replaceSchema.parse(await readJsonBody(req, 4000));
    return Response.json({ data: afterChange(await replaceMemoryLine(revision, line, text)) });
  } catch (error) {
    console.error("/api/memory/document PATCH error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to change the memory document");
  }
}

async function DELETEHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    const { revision, lines } = deleteSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
    return Response.json({ data: afterChange(lines ? await deleteMemoryLines(revision, lines) : await clearMemoryDocument(revision)) });
  } catch (error) {
    console.error("/api/memory/document DELETE error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to delete from the memory document");
  }
}

/** Sorts the notes again now: after an earlier try failed, or for notes kept from before there were topics. */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("memory");
    return Response.json({ data: afterChange(await readMemoryDocument()) });
  } catch (error) {
    console.error("/api/memory/document POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to sort the memory document");
  }
}

export const GET = protectDataOperation(GETHandler);
export const PATCH = protectDataOperation(PATCHHandler);
export const POST = protectDataOperation(POSTHandler);
export const DELETE = protectDataOperation(DELETEHandler);
