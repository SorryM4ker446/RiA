"use client";
import { useLocale } from "@/lib/locale/client";

import { t, formatDateTime, localizeMessage } from "@/lib/locale";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { SettingsLink } from "@/features/settings/settings-context";
import { eventLabel } from "@/lib/activity/types";
type Source = { event: { label: string; kind: string; occurredAt: string }; entity: Record<string, unknown> | null; documentHref: string | null };
export default function EventSourcePage() {
  useLocale();
  const { id } = useParams<{ id: string }>();
  return <EventSourceContent key={id} id={id} />;
}
function EventSourceContent({ id }: { id: string }) {
  useLocale();
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/activity/events/${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("ui.activity.events.couldNotLoadSource"));
      if (!controller.signal.aborted) setSource(payload.data);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.activity.events.couldNotLoadSource")); });
    return () => controller.abort();
  }, [id]);
  return <main className="mx-auto max-w-3xl space-y-4 p-6">
    <SettingsLink className="underline" section="automation">{t("ui.activity.events.backToSettingsAndReviews")}</SettingsLink>
    <h1 className="text-xl font-semibold">{t("ui.activity.events.reviewEventSource")}</h1>
    {error ? <p role="alert">{localizeMessage(error)}</p> : source ? <>
      <p>{eventLabel(source.event.kind)} · {formatDateTime(new Date(source.event.occurredAt))}</p>
      <h2 className="text-lg font-medium break-words">{source.event.label}</h2>
      <p className="text-sm text-muted-foreground">{t("ui.activity.events.namesWereRecordedWhenTheEvent")}</p>
      {source.entity ? <dl className="space-y-2">{Object.entries(source.entity).map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{({ title: t("ui.activity.events.taskName"), details: t("ui.activity.events.taskDescription"), status: t("ui.activity.events.currentStatus"), filename: t("ui.activity.events.filename"), collection: t("ui.activity.events.collection"), key: t("ui.activity.events.memoryName"), value: t("ui.activity.events.currentMemoryContent"), confirmed: t("ui.activity.events.currentlyConfirmed") })[key] ?? key}</dt><dd className="whitespace-pre-wrap break-words">{value === null ? "—" : String(value)}</dd></div>)}</dl> : <p>{t("ui.activity.events.theOriginalTaskDocumentOrMemory")}</p>}
      {source.documentHref ? <Link className="underline" href={source.documentHref}>{t("ui.activity.events.openCurrentDocument")}</Link> : null}
    </> : <p>{t("ui.activity.events.loadingEventSource")}</p>}
  </main>;
}
