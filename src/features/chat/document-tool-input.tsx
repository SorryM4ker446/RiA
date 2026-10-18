"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { SelectField, SelectOption } from "@/components/ui/select";
import { chatApi } from "@/features/chat/api-client";
import type { ToolDocumentSelection } from "@/features/chat/types";
import { decodeDocumentScope } from "@/lib/documents/scope";

export function DocumentToolInput({ value, onChange, scope = "", disabled }: {
  value: ToolDocumentSelection | null;
  onChange: (document: ToolDocumentSelection | null) => void;
  scope?: string;
  disabled: boolean;
}) {
  const [documents, setDocuments] = useState<Array<ToolDocumentSelection & { collection: string | null }>>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    onChange(null);
    const controller = new AbortController();
    void chatApi.listDocuments(controller.signal).then(({ data }) => {
      if (controller.signal.aborted) return;
      const collections = decodeDocumentScope(scope);
      setDocuments(data.filter(document => !collections.length || (document.collection !== null && collections.includes(document.collection))));
      setError(""); setLoadedScope(scope);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setDocuments([]); setLoadedScope(scope);
      setError(failure instanceof Error ? failure.message : "无法加载知识库文档。");
    });
    return () => controller.abort();
  }, [scope, revision, onChange]);
  const loading = loadedScope !== scope;
  const available = !loading && documents.some(document => document.id === value?.id);
  return <FieldGroup className="px-4 pb-3 pt-4">
    <Field>
      <FieldLabel htmlFor="tool-document">知识库文档</FieldLabel>
      <SelectField id="tool-document" value={available ? value!.id : ""} disabled={disabled || loading || !!error} onValueChange={id => onChange(documents.find(document => document.id === id) ?? null)}>
        <SelectOption value="">{loading ? "正在加载文档…" : "选择要处理的文档"}</SelectOption>
        {documents.map(document => <SelectOption key={document.id} value={document.id}>{document.filename}{document.collection ? ` · ${document.collection}` : ""}</SelectOption>)}
      </SelectField>
      {error ? <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-xs text-destructive">{error}</p><Button size="sm" variant="ghost" disabled={disabled} onClick={() => { setLoadedScope(null); onChange(null); setRevision(old => old + 1); }}><RefreshCw data-icon="inline-start" />重试</Button></div> : !loading && !documents.length ? <FieldDescription>当前知识范围内还没有文档。<Link href="/knowledge">去知识库导入</Link></FieldDescription> : <FieldDescription>按文件名选择，执行不会修改原文档。</FieldDescription>}
    </Field>
  </FieldGroup>;
}
