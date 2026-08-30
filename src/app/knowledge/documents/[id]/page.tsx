import { DocumentViewer } from "@/features/knowledge/document-viewer";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentViewer id={id} key={id} />;
}
