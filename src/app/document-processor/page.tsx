import { DocumentWorkspace } from "@/features/document-processor/document-workspace";

export default async function DocumentProcessorPage({ searchParams }: { searchParams: Promise<{ document?: string | string[] }> }) {
  const value = (await searchParams).document;
  return <DocumentWorkspace initialDocumentId={typeof value === "string" ? value : undefined} />;
}
