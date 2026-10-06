import { DocumentViewer } from "@/features/knowledge/document-viewer";

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ version?: string }> }) {
  const [{ id }, { version }] = await Promise.all([params, searchParams]);
  return <DocumentViewer id={id} version={version} key={`${id}:${version ?? ""}`} />;
}
