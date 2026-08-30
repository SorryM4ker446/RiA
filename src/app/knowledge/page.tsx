"use client";

import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, BookOpen, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils/cn";
import { DocumentLibrary } from "@/features/knowledge/document-library";

type KnowledgeEntry = {
  id: string;
  key: string;
  value: string;
  score: number | null;
  createdAt: string;
  updatedAt: string;
};


function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadEntries(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const response = await fetch("/api/knowledge?limit=100", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, "读取知识条目失败"));
      }

      setEntries(Array.isArray(payload.data) ? payload.data : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取知识条目失败");
    } finally {
      if (!options?.silent) {
        setIsLoading(false);
      }
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) {
      setError("请填写知识标题和内容。");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: normalizedKey,
          value: normalizedValue,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, "保存知识条目失败"));
      }

      setKey("");
      setValue("");
      await loadEntries({ silent: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存知识条目失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteEntry(entryId: string) {
    const previous = entries;
    setEntries((current) => current.filter((entry) => entry.id !== entryId));
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/${entryId}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, "删除知识条目失败"));
      }
    } catch (deleteError) {
      setEntries(previous);
      setError(deleteError instanceof Error ? deleteError.message : "删除知识条目失败");
    }
  }

  useEffect(() => {
    void loadEntries();
  }, []);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            className="mb-3 inline-flex h-8 items-center rounded-md bg-muted px-3 text-xs font-medium text-foreground transition hover:bg-muted/80"
            href="/chat"
          >
            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
            返回聊天
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <BookOpen className="h-5 w-5 text-primary" />
            知识库管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">这些条目会进入 searchKnowledge 的可检索范围。</p>
        </div>
        <Button disabled={isLoading} onClick={() => void loadEntries()} type="button" variant="secondary">
          <RefreshCw className={cn("mr-2 h-4 w-4", isLoading ? "animate-spin" : "")} />
          刷新
        </Button>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>知识库操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DocumentLibrary />
      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="glass-surface h-fit">
          <CardHeader>
            <CardTitle>新增知识</CardTitle>
            <CardDescription>保存后可立即被知识检索工具命中</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={onSubmit}>
              <Input onChange={(event) => setKey(event.target.value)} placeholder="知识标题" value={key} />
              <Textarea
                className="min-h-40"
                onChange={(event) => setValue(event.target.value)}
                placeholder="知识内容"
                value={value}
              />
              <Button className="w-full" disabled={isSaving} type="submit">
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                新增知识
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="glass-surface min-h-[520px] overflow-hidden">
          <CardHeader className="border-b border-border/70">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>知识条目</CardTitle>
                <CardDescription>按最近更新时间排序</CardDescription>
              </div>
              <Badge variant="outline">{entries.length} 条</Badge>
            </div>
          </CardHeader>
          <CardContent className="chat-list-scroll max-h-[calc(100vh-15rem)] overflow-y-auto p-4 pr-3">
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : entries.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">暂无知识条目。</p>
            ) : (
              <div className="space-y-3">
                {entries.map((entry) => (
                  <article
                    className="rounded-md border border-border/80 bg-background/50 p-4 transition-colors duration-200"
                    key={entry.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold">{entry.key}</h2>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {entry.value}
                        </p>
                      </div>
                      <Button
                        aria-label={`删除知识 ${entry.key}`}
                        onClick={() => void deleteEntry(entry.id)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="mt-3 text-[11px] text-muted-foreground">更新于 {formatTime(entry.updatedAt)}</p>
                  </article>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
