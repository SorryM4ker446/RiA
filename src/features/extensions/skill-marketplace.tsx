"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatNumber, localizeMessage } from "@/lib/locale";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Download, Loader2, Search, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToolbarSearch } from "@/components/layout/page-toolbar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { MarketSkill } from "@/lib/plugins/skill-marketplace";
import type { PluginPreview, PluginView } from "@/lib/plugins/types";
import { SkillFiles } from "./skill-files";

type Props = { plugins: PluginView[]; busy: boolean; actionError: string; onInstall: (preview: PluginPreview, allowLocal: boolean, onInstalled: () => void) => void };
async function read<T>(params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/plugins/skills?${new URLSearchParams(params)}`, { signal, cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(result, t("ui.extensions.skill-marketplace.couldNotAccessSkillsSh")));
  return result.data;
}

export function SkillMarketplace({ plugins, busy, actionError, onInstall }: Props) {
  useLocale();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MarketSkill[] | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<MarketSkill | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [detailError, setDetailError] = useState("");
  const [reading, setReading] = useState(false);
  const searchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => () => { searchRequest.current?.abort(); detailRequest.current?.abort(); }, []);

  async function search() {
    searchRequest.current?.abort(); const controller = new AbortController(); searchRequest.current = controller;
    setSearching(true); setError("");
    try {
      const result = await read<{ items: MarketSkill[]; skipped: number }>({ q: query.trim() }, controller.signal);
      if (!controller.signal.aborted) { setItems(result.items); setSkipped(result.skipped); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.extensions.skill-marketplace.searchFailed")); }
    finally { if (searchRequest.current === controller) { searchRequest.current = null; setSearching(false); } }
  }
  async function detail(item: MarketSkill) {
    detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    setSelected(item); setOpen(true); setPreview(null); setDetailError(""); setReading(true);
    try {
      const result = await read<PluginPreview>({ repository: item.repository, skill: item.skill }, controller.signal);
      if (!controller.signal.aborted) setPreview(result);
    } catch (failure) { if (!controller.signal.aborted) setDetailError(failure instanceof Error ? failure.message : t("ui.extensions.skill-marketplace.couldNotLoadSkillDetails")); }
    finally { if (detailRequest.current === controller) { detailRequest.current = null; setReading(false); } }
  }
  function close() { detailRequest.current?.abort(); detailRequest.current = null; setOpen(false); setReading(false); }
  const installed = selected && plugins.some(plugin => plugin.packageId === selected.packageId);
  return <section aria-label={t("ui.extensions.skill-marketplace.skillsShMarketplace")} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-col gap-1"><h3 className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />{t("ui.extensions.skill-marketplace.discoverSkills")}<Badge variant="outline">skills.sh</Badge></h3><p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.skill-marketplace.searchCommunitySkillsPreviewInstructionsAnd")}</p></div>
    <form className="flex items-end gap-2" onSubmit={event => { event.preventDefault(); void search(); }}><Field className="min-w-0 flex-1"><FieldLabel htmlFor="skill-market-search" className="sr-only">{t("ui.extensions.skill-marketplace.searchCommunitySkills")}</FieldLabel><ToolbarSearch id="skill-market-search" value={query} maxLength={100} placeholder={t("ui.extensions.skill-marketplace.searchWritingReactDesignAndMore")} onChange={event => { searchRequest.current?.abort(); searchRequest.current = null; setSearching(false); setQuery(event.target.value); setItems(null); setError(""); }} /></Field><Button type="submit" size="sm" variant="secondary" disabled={busy || searching || query.trim().length < 2}>{searching ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Search data-icon="inline-start" />}{t("knowledge.search")}</Button></form>
    {error && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.skill-marketplace.searchIncomplete")}</AlertTitle><AlertDescription>{localizeMessage(error)}<Button variant="ghost" size="sm" disabled={searching || query.trim().length < 2} onClick={() => void search()}>{t("ui.extensions.skill-marketplace.retrySearch")}</Button></AlertDescription></Alert>}
    {searching && items === null ? <Skeleton className="h-28 rounded-xl" /> : items?.length ? <div role="region" aria-label={t("ui.extensions.skill-marketplace.communitySkillSearchResults")} tabIndex={0} className="registry-results-scroll skill-results-scroll chat-list-scroll min-w-0 overflow-y-auto overscroll-contain rounded-xl">{items.map(item => {
      const exists = plugins.some(plugin => plugin.packageId === item.packageId);
      return <article key={item.packageId} className="registry-result-row management-row flex min-w-0 items-center gap-3 rounded-xl p-4"><div className="flex min-w-0 flex-1 flex-col gap-1"><h4 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{item.name}</h4><p className="break-all text-xs leading-6 text-muted-foreground">{item.repository} · {formatNumber(item.installs)} {t("ui.extensions.skill-marketplace.installs")}</p></div><Button size="sm" variant="ghost" disabled={busy} onClick={event => { opener.current = event.currentTarget; void detail(item); }}>{exists ? <><Check data-icon="inline-start" />{t("ui.extensions.plugin-packages.installed")}</> : <>{t("media.viewDetails")}<ArrowRight data-icon="inline-end" /></>}</Button></article>;
    })}</div> : items !== null && !error ? <Empty><EmptyHeader><EmptyMedia><Search /></EmptyMedia><EmptyTitle>{t("ui.extensions.skill-marketplace.noCommunitySkillsFound")}</EmptyTitle><EmptyDescription>{t("ui.extensions.skill-marketplace.tryEnglishKeywordsSuchAsWriting")}</EmptyDescription></EmptyHeader></Empty> : null}
    {items !== null && <p role="status" className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.skill-marketplace.showing")}{items.length} {t("ui.extensions.skill-marketplace.resultsUpTo30PerSearch")}{skipped ? tf("ui.extensions.skill-marketplace.sourcesOrFormatsAreNotSupported", { v0: skipped }) : ""}</p>}
    <Sheet open={open} onOpenChange={value => { if (!value && !busy) close(); }}><SheetContent side="right" className="plugin-package-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel={t("ui.extensions.skill-marketplace.closeSkillDetails")} onCloseAutoFocus={event => { event.preventDefault(); (opener.current?.isConnected ? opener.current : document.getElementById("plugin-import"))?.focus(); }}>
      <header className="flex shrink-0 flex-col gap-2 pr-8"><SheetTitle className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{preview?.manifest.name ?? selected?.name ?? t("ui.extensions.skill-marketplace.skillDetails")}</SheetTitle><SheetDescription className="break-all text-xs">{selected?.repository} {t("ui.extensions.skill-marketplace.skillsShCommunitySkill")}</SheetDescription></header>
      <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
        {reading && <Skeleton className="h-44 rounded-xl" />}
        {(detailError || actionError) && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-manager.operationIncomplete")}</AlertTitle><AlertDescription>{detailError || actionError}{detailError && selected && <Button size="sm" variant="ghost" onClick={() => void detail(selected)}>{t("ui.chat.terminal-result.retryLoading")}</Button>}</AlertDescription></Alert>}
        {preview?.manifest.marketplace && <><p className="text-sm leading-7 text-muted-foreground">{preview.manifest.description}</p><SkillFiles key={preview.digest} snapshot={preview.manifest.marketplace} /><p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.skill-marketplace.disabledAfterInstallationEnableInMy")}</p></>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2"><Button size="sm" variant="ghost" disabled={busy} onClick={close}>{t("window.close")}</Button><Button size="sm" disabled={busy || reading || !preview || !!installed} onClick={() => { if (preview) onInstall(preview, false, close); }}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}{installed ? t("ui.extensions.plugin-packages.installed") : t("ui.extensions.skill-marketplace.installSkill")}</Button></footer>
    </SheetContent></Sheet>
  </section>;
}
