import { redirect } from "next/navigation";

export default async function DocumentProcessorPage({ searchParams }: { searchParams: Promise<{ document?: string | string[] }> }) {
  const value = (await searchParams).document;
  redirect(typeof value === "string" && value ? `/knowledge/documents/${encodeURIComponent(value)}` : "/knowledge");
}
