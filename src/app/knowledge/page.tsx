"use client";

import { getApiErrorMessage as readApiErrorMessage } from "@/lib/api-error-message";
import { formatDateTime } from "@/lib/locale";

import { FormEvent, useEffect, useState } from "react";

import { useAwaitingFirstLoad } from "@/lib/use-awaiting-first-load";
import Link from "next/link";
import { ArrowLeft, BookOpen, Loader2, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DocumentLibrary } from "@/features/knowledge/document-library";
import { t } from "@/lib/locale";

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
  return formatDateTime(date, {
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
  const awaitingFirstEntryLoad = useAwaitingFirstLoad(isLoading, "entries");

  async function loadEntries(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const response = await fetch("/api/knowledge?limit=100", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.load")));
      }

      setEntries(Array.isArray(payload.data) ? payload.data : []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("knowledge.error.load"));
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
      setError(t("knowledge.error.required"));
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
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.save")));
      }

      setKey("");
      setValue("");
      await loadEntries({ silent: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("knowledge.error.save"));
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
        throw new Error(readApiErrorMessage(payload, t("knowledge.error.delete")));
      }
    } catch (deleteError) {
      setEntries(previous);
      setError(deleteError instanceof Error ? deleteError.message : t("knowledge.error.delete"));
    }
  }

  useEffect(() => {
    void loadEntries();
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            href="/chat"
          >
            <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
            {t("knowledge.backToChat")}
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-headline">
            <BookOpen aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
            {t("knowledge.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("knowledge.description")}</p>
        </div>
        {/* `refreshing` keeps the label and width fixed while the request is in
            flight, so the header does not reflow under the spinner. */}
        <RefreshButton
          disabled={isLoading && entries.length === 0}
          onClick={() => void loadEntries()}
          refreshing={isLoading}
          variant="outline"
          label={t("knowledge.refresh")}
        />
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("knowledge.error.title")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <DocumentLibrary />
      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{t("knowledge.createTitle")}</CardTitle>
            <CardDescription>{t("knowledge.createDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={onSubmit}>
              <Input onChange={(event) => setKey(event.target.value)} placeholder={t("knowledge.keyPlaceholder")} value={key} />
              <Textarea
                className="min-h-40"
                onChange={(event) => setValue(event.target.value)}
                placeholder={t("knowledge.valuePlaceholder")}
                value={value}
              />
              <Button className="w-full" disabled={isSaving} type="submit">
                {isSaving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <Plus aria-hidden="true" className="mr-2 h-4 w-4" />}
                {t("knowledge.create")}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="min-h-[520px] overflow-hidden">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>{t("knowledge.entriesTitle")}</CardTitle>
                <CardDescription>{t("knowledge.entriesDescription")}</CardDescription>
              </div>
              <Badge variant="outline">{`${entries.length} ${t("knowledge.entryCountUnit")}`}</Badge>
            </div>
          </CardHeader>
          <CardContent className="chat-list-scroll max-h-[calc(100vh-15rem)] overflow-y-auto p-4 pr-3">
            {/* The skeleton is a first-load placeholder, not a refresh state.
                A refresh keeps the entries on screen and only spins the button;
                replacing them with placeholders made every refresh read as a
                page reload. */}
            {awaitingFirstEntryLoad ? (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : entries.length === 0 ? (
              <p className="empty-state !p-4 !text-left">{t("knowledge.empty")}</p>
            ) : (
              <div className="space-y-3">
                {entries.map((entry) => (
                  <article
                    className="rounded-lg bg-background p-4 shadow-hairline transition-shadow duration-200 hover:shadow-card"
                    key={entry.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold tracking-label">{entry.key}</h2>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {entry.value}
                        </p>
                      </div>
                      <Button
                        aria-label={`${t("knowledge.deleteLabel")} ${entry.key}`}
                        onClick={() => void deleteEntry(entry.id)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </div>
                    <p className="label-mono mt-3">{`${t("knowledge.updatedAt")} ${formatTime(entry.updatedAt)}`}</p>
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
