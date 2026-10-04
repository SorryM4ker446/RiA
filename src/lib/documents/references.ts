import { db } from "@/db";
import type { DocumentReferenceStatus, DocumentSource } from "@/lib/documents/types";

export async function checkDocumentReferences(sources: DocumentSource[]): Promise<DocumentReferenceStatus[]> {
  const documents = await db.knowledgeDocument.findMany({ where: { id: { in: sources.map(source => source.documentId) } },
    select: { id: true, contentHash: true, collection: true, chunks: { where: { id: { in: sources.map(source => source.chunkId) } }, select: { id: true, text: true } } },
  });
  const byId = new Map(documents.map(document => [document.id, document]));
  return sources.map(source => {
    const document = byId.get(source.documentId);
    const chunk = document?.chunks.find(chunk => chunk.id === source.chunkId);
    const status = !document ? "deleted" : !chunk ? "changed" : !source.contentHash ? "unverified"
      : document.contentHash !== source.contentHash || chunk.text !== source.snippet ||
        (source.collection !== undefined && source.collection !== document.collection) ? "changed" : "current";
    return { chunkId: source.chunkId, status };
  });
}
