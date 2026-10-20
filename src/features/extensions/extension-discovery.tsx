"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatDateTime, localizeMessage } from "@/lib/locale";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ExternalLink, Loader2, Puzzle, Search } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { RegistryConnectionDraft, RegistryPage, RegistryServer } from "@/lib/extensions/registry-types";

async function registryRequest<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, t("ui.extensions.extension-discovery.couldNotLoadTheOfficialCatalog")));
  return payload.data;
}

function connectionHint(server: RegistryServer) {
  if (server.status === "deprecated") return t("ui.extensions.extension-discovery.deprecated");
  if (server.remotes.some(remote => !remote.unavailableReason)) return t("ui.extensions.extension-discovery.remoteMCP");
  return server.packages.length ? t("ui.extensions.extension-discovery.localInstallationRequired") : t("ui.extensions.extension-discovery.manualConfigurationRequired");
}

type Props = { canAdd: boolean; connectedUrls: string[]; onAdd: (draft: RegistryConnectionDraft, trigger: HTMLElement | null) => void };

export function ExtensionDiscovery({ canAdd, connectedUrls, onAdd }: Props) {
  useLocale();
  const [draftSearch, setDraftSearch] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; page: RegistryPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [failedCursor, setFailedCursor] = useState<string | undefined>();
  const [selection, setSelection] = useState<RegistryServer | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsSession, setDetailsSession] = useState(0);
  const request = useRef<AbortController | null>(null);
  const resultsViewport = useRef<HTMLDivElement | null>(null);
  const previousTop = useRef(0);
  const detailsTrigger = useRef<HTMLElement | null>(null);
  const handingOff = useRef(false);

  const load = useCallback(async (search: string, cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(""); setQuery(search); setFailedCursor(cursor);
    if (!cursor) {
      previousTop.current = 0;
      resultsViewport.current?.scrollTo({ top: 0, behavior: "instant" });
      setResult(old => old?.query === search ? old : null);
    }
    try {
      const params = new URLSearchParams({ search });
      if (cursor) params.set("cursor", cursor);
      const page = await registryRequest<RegistryPage>(`/api/extensions/registry?${params}`, controller.signal);
      if (controller.signal.aborted) return;
      setResult(old => {
        if (!cursor || old?.query !== search) return { query: search, page };
        const names = new Set(old.page.items.map(item => item.name));
        return { query: search, page: { ...page, skipped: old.page.skipped + page.skipped, items: [...old.page.items, ...page.items.filter(item => !names.has(item.name))] } };
      });
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.extensions.extension-discovery.couldNotLoadOfficialCatalog") ); }
    finally { if (request.current === controller && !controller.signal.aborted) { request.current = null; setLoading(false); } }
  }, []);
  useEffect(() => { void load(""); return () => request.current?.abort(); }, [load]);

  return <section aria-label={t("ui.extensions.extension-discovery.discoverExtensions")} className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{t("ui.extensions.extension-discovery.findServicesInTheOfficialMCP")}</p><a href="https://registry.modelcontextprotocol.io" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline">{t("ui.models.officialCatalog")}<ExternalLink className="size-3" aria-hidden="true" /></a></div>
    <form onSubmit={event => { event.preventDefault(); void load(draftSearch.trim()); }}>
      <FieldGroup className="flex-row items-end gap-2"><Field className="min-w-0 flex-1 gap-2"><FieldLabel htmlFor="registry-search" className="sr-only">{t("ui.extensions.extension-discovery.searchMCPExtensions")}</FieldLabel><Input id="registry-search" maxLength={100} placeholder={t("ui.extensions.extension-discovery.searchByExtensionName")} value={draftSearch} onChange={event => setDraftSearch(event.target.value)} /></Field><Button type="submit" variant="secondary"><Search data-icon="inline-start" />{t("knowledge.search")}</Button></FieldGroup>
    </form>
    {error && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-discovery.catalogNotUpdated")}</AlertTitle><AlertDescription>{localizeMessage(error)}<Button size="sm" variant="ghost" onClick={() => void load(query, failedCursor)}>{t("ui.chat.chat-toolbar.retry")}</Button></AlertDescription></Alert>}
    <div ref={resultsViewport} role="region" aria-label={t("ui.extensions.extension-discovery.extensionCatalogResults")} tabIndex={0} aria-busy={loading} className="registry-results-scroll chat-list-scroll flex flex-col gap-2 overflow-y-auto overscroll-contain p-1" onScroll={event => {
      const node = event.currentTarget;
      const movingDown = node.scrollTop > previousTop.current;
      previousTop.current = node.scrollTop;
      if (movingDown && node.scrollTop + node.clientHeight >= node.scrollHeight - 100 && !loading && !error && !detailsOpen && !request.current && result?.page.nextCursor) {
        void load(query, result.page.nextCursor);
      }
    }}>
      {loading && !result ? <div role="status" aria-label={t("ui.extensions.extension-discovery.loadingOfficialCatalog")} className="flex flex-col gap-2">{[0, 1, 2].map(key => <Skeleton key={key} className="h-28 rounded-xl" />)}</div> : null}
      {result?.page.items.map(server => <article key={server.name} aria-label={server.title} className="registry-result-row management-row flex shrink-0 items-start gap-3 rounded-xl p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Puzzle className="size-4" aria-hidden="true" /></div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5"><div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]">{server.title}</h2><Badge variant="outline">{connectionHint(server)}</Badge></div><p className="truncate text-xs text-muted-foreground" title={server.name}>{server.name} · v{server.version}</p>{server.description && <p className="line-clamp-2 break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{server.description}</p>}
          <Button className="self-start" size="sm" variant="ghost" aria-label={tf("ui.extensions.extension-discovery.viewDetailsFor", { v0: server.title })} onClick={event => { detailsTrigger.current = event.currentTarget; handingOff.current = false; setSelection(server); setDetailsSession(value => value + 1); setDetailsOpen(true); }}>{t("media.viewDetails")}<ArrowRight data-icon="inline-end" /></Button>
        </div>
      </article>)}
      {!loading && !error && result && !result.page.items.length ? <Empty><EmptyHeader><EmptyMedia><Search /></EmptyMedia><EmptyTitle>{t("ui.extensions.extension-discovery.noMatchingExtensions")}</EmptyTitle><EmptyDescription>{t("ui.extensions.extension-discovery.tryAServiceNameOrEnglish")}</EmptyDescription></EmptyHeader></Empty> : null}
      <div className="flex min-h-14 shrink-0 items-center justify-center py-3" aria-live="polite">
        {loading && result ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden="true" />{failedCursor ? t("ui.extensions.extension-discovery.loadingMoreExtensions") : t("ui.extensions.extension-discovery.updatingCatalog")}</p> : result?.page.nextCursor && !error ? <Button variant="ghost" size="sm" disabled={detailsOpen} onClick={() => { if (!request.current) void load(query, result.page.nextCursor!); }}>{t("ui.extensions.extension-discovery.scrollToLoadMore")}</Button> : !error && result?.page.items.length && !result.page.nextCursor ? <p className="text-xs text-muted-foreground">{t("ui.extensions.extension-discovery.allMatchingExtensionsShown")}</p> : null}
      </div>
    </div>
    {result && <p className="text-xs text-muted-foreground" aria-live="polite">{t("ui.extensions.extension-discovery.showing")}{result.page.items.length} {t("ui.extensions.extension-discovery.extensions")}{result.page.skipped ? tf("ui.extensions.extension-discovery.skippedUnavailableOrDuplicateEntries", { v0: result.page.skipped }) : ""}</p>}
    <p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.extension-discovery.descriptionsAreProvidedByPublishersAfter")}</p>
    {selection && <RegistryDetails key={detailsSession} server={selection} open={detailsOpen} canAdd={canAdd} connectedUrls={connectedUrls} onClose={() => setDetailsOpen(false)} returnFocus={() => { if (!handingOff.current && detailsTrigger.current?.isConnected) detailsTrigger.current.focus(); }} onAdd={draft => { handingOff.current = true; setDetailsOpen(false); onAdd(draft, detailsTrigger.current); }} />}
  </section>;
}

function RegistryDetails({ server, open, canAdd, connectedUrls, onClose, returnFocus, onAdd }: { server: RegistryServer; open: boolean; canAdd: boolean; connectedUrls: string[]; onClose: () => void; returnFocus: () => void; onAdd: (draft: RegistryConnectionDraft) => void }) {
  useLocale();
  const [data, setData] = useState<RegistryServer | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ name: server.name, version: server.version });
    registryRequest<RegistryServer>(`/api/extensions/registry/detail?${params}`, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.extensions.extension-discovery.couldNotLoadExtensionDetails") ); });
    return () => controller.abort();
  }, [server.name, server.version, open, retry]);
  return <Sheet open={open} onOpenChange={next => { if (!next) onClose(); }}><SheetContent side="right" className="registry-details-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel={t("ui.extensions.extension-discovery.closeExtensionDetails")} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
    <header className="flex shrink-0 flex-col gap-2 pr-8"><SheetTitle className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{server.title}</SheetTitle><SheetDescription className="break-words text-xs [overflow-wrap:anywhere]">{server.name} · v{server.version}</SheetDescription></header>
    <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
      {error ? <Alert variant="destructive"><AlertTitle>{t("ui.chat.run-records.couldNotLoadDetails")}</AlertTitle><AlertDescription>{localizeMessage(error)}<Button variant="ghost" size="sm" onClick={() => { setError(""); setData(null); setRetry(value => value + 1); }}>{t("ui.extensions.extension-discovery.retryDetails")}</Button></AlertDescription></Alert> : !data ? <div role="status" aria-label={t("ui.extensions.extension-discovery.loadingExtensionDetails")} className="flex flex-col gap-3"><Skeleton className="h-20" /><Skeleton className="h-40" /></div> : <>
        <div className="flex flex-col gap-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{data.status === "active" ? t("ui.extensions.extension-discovery.activeInCatalog") : t("ui.extensions.extension-discovery.deprecated")}</Badge>{data.updatedAt && <span className="text-xs text-muted-foreground">{t("knowledge.updatedAt")}{formatDateTime(new Date(data.updatedAt), { year: "numeric", month: "short", day: "numeric" })}</span>}</div><p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{data.description || t("ui.extensions.extension-discovery.thePublisherHasNotProvidedA")}</p><div className="flex flex-wrap gap-1">{data.repositoryUrl && <Button asChild size="sm" variant="ghost"><a href={data.repositoryUrl} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" />{t("ui.extensions.extension-discovery.projectRepository")}</a></Button>}{data.websiteUrl && <Button asChild size="sm" variant="ghost"><a href={data.websiteUrl} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" />{t("ui.extensions.extension-discovery.projectWebsite")}</a></Button>}</div></div>
        {data.status === "deprecated" && <p className="text-sm text-muted-foreground">{t("ui.extensions.extension-discovery.thePublisherDeprecatedThisVersionIt")}</p>}
        <section aria-label={t("ui.extensions.extension-discovery.remoteConnections")} className="flex flex-col gap-3"><h3 className="text-sm font-medium">{t("ui.extensions.extension-discovery.remoteConnections")}</h3>{!data.remotes.length && <p className="text-sm text-muted-foreground">{t("ui.extensions.extension-discovery.thisEntryProvidesNoRemoteMCP")}</p>}{data.remotes.map((remote, index) => {
          const existing = connectedUrls.includes(remote.url);
          return <div key={index} className="flex flex-col gap-3 rounded-xl bg-muted/50 p-4"><Badge variant="outline" className="self-start">{remote.type === "streamable-http" ? "Streamable HTTP" : remote.type}</Badge><code className="break-all text-xs leading-6">{remote.url || t("ui.extensions.extension-discovery.noUsableAddressProvided")}</code>{remote.headers.length > 0 && <p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.extension-discovery.headers")}{remote.headers.map(header => `${header.key}${header.required ? t("ui.extensions.extension-discovery.required") : t("ui.extensions.extension-discovery.optional")}`).join("、")}{t("ui.extensions.extension-discovery.enterFullValuesWhenAdding")}</p>}{remote.unavailableReason && <p className="text-xs leading-6 text-muted-foreground">{remote.unavailableReason}</p>}{existing && <p className="text-xs text-muted-foreground">{t("ui.extensions.extension-discovery.aConnectionToThisAddressAlready")}</p>}<Button size="sm" className="self-start" disabled={!canAdd || !!remote.unavailableReason || data.status !== "active"} onClick={() => onAdd({ name: data.title.slice(0, 80), url: remote.url, headers: remote.headers, source: { name: data.name, version: data.version } })}>{existing ? t("ui.extensions.extension-discovery.addAnotherConnection") : t("ui.extensions.extension-discovery.addConnection")}<ArrowRight data-icon="inline-end" /></Button></div>;
        })}</section>
        {data.packages.length > 0 && <section aria-label={t("ui.extensions.extension-discovery.localPackages")} className="flex flex-col gap-3"><h3 className="text-sm font-medium">{t("ui.extensions.extension-discovery.localPackages")}</h3><p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.extension-discovery.installTheRuntimeAndProgramYourself")}</p>{data.packages.map((item, index) => <div key={index} className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3"><p className="break-all text-sm">{item.identifier}</p><p className="break-all text-xs text-muted-foreground">{item.registry} · {item.transport} · {item.version}</p></div>)}</section>}
        {!canAdd && <p className="text-xs text-muted-foreground">{t("ui.extensions.extension-discovery.cannotAddAConnectionNowWait")}</p>}
      </>}
    </div>
  </SheetContent></Sheet>;
}
