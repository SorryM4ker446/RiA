"use client";
import { useLocale } from "@/lib/locale/client";

import { localizeMessage, t, tf } from "@/lib/locale";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Download, Loader2, MoreHorizontal, Package, Power, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Status } from "@/components/ui/status";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { ToolbarSearch } from "@/components/layout/page-toolbar";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { ExtensionView } from "@/lib/extensions/store";
import type { PluginManifest, PluginPreview, PluginView } from "@/lib/plugins/types";
import { SkillMarketplace } from "./skill-marketplace";
import { SkillFiles } from "./skill-files";
import { removalKey } from "@/lib/ui/removal";

type Props = {
  mode: "installed" | "market"; plugins: PluginView[]; catalog: PluginPreview[];
  connections: ExtensionView[]; busy: boolean; loading: boolean;
  actionError: string; localProcessesAllowed: boolean;
  onInstall: (preview: PluginPreview, allowLocal: boolean, onInstalled: () => void) => void;
  onToggle: (plugin: PluginView) => void; onUninstall: (plugin: PluginView) => void;
  onConnection: (action: "configure" | "detect" | "tools", row: ExtensionView, trigger: HTMLElement | null) => void;
};
const ready = (row: ExtensionView) => row.enabled && row.tested && row.credentialsAvailable && row.tools.some(tool => tool.enabled);

export function PluginPackages({ mode, plugins, catalog, connections, busy, loading, actionError, localProcessesAllowed, onInstall, onToggle, onUninstall, onConnection }: Props) {
  useLocale();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState<PluginView | null>(null);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [allowLocal, setAllowLocal] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const draftVersion = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const handoff = useRef(false);
  useEffect(() => () => { pending.current?.abort(); draftVersion.current++; }, []);
  const current = installed ? plugins.find(plugin => plugin.id === installed.id) ?? null : null;
  const manifest = current?.manifest ?? preview?.manifest;
  const bundledPreview = catalog.some(item => item.digest === (current?.digest ?? preview?.digest));
  const previewText = (value: string) => bundledPreview ? localizeMessage(value) : value;
  const owned = current ? connections.filter(row => row.pluginId === current.id) : [];
  const needsSetup = current ? owned.length !== current.connections.length || owned.some(row => !ready(row)) : false;
  const needsLocal = manifest?.connections.some(connection => connection.config.type === "mcp-stdio") ?? false;

  function show(trigger: HTMLElement, item?: PluginPreview, plugin?: PluginView) {
    pending.current?.abort(); pending.current = null; draftVersion.current++;
    opener.current = trigger; handoff.current = false;
    setInstalled(plugin ?? null); setSource(""); setPreview(item ?? null); setPreviewing(false); setError(""); setAllowLocal(false); setOpen(true);
  }
  function changeSource(value: string) {
    pending.current?.abort(); pending.current = null; draftVersion.current++;
    setSource(value); setPreview(null); setPreviewing(false); setError(""); setAllowLocal(false);
  }
  async function readFile(file?: File) {
    if (!file) return;
    changeSource(""); const version = draftVersion.current;
    if (file.size > 2_097_152) { setError(t("ui.extensions.plugin-packages.pluginPackagesMustNotExceed2")); return; }
    try { const text = await file.text(); if (version === draftVersion.current) changeSource(text); }
    catch { if (version === draftVersion.current) setError(t("ui.extensions.plugin-packages.couldNotReadPluginPackage")); }
  }
  async function inspect() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setError(""); setPreviewing(true);
    try {
      if (new TextEncoder().encode(source).length > 2_097_152) throw new Error(t("ui.extensions.plugin-packages.pluginPackagesMustNotExceed2"));
      let value: unknown; try { value = JSON.parse(source); } catch { throw new Error(t("ui.extensions.plugin-packages.enterAValidJSONPluginPackage")); }
      const response = await fetch("/api/plugins/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("ui.extensions.plugin-packages.unsupportedPluginFormat")));
      if (!controller.signal.aborted) setPreview(payload.data);
    } catch (failure) { if (!controller.signal.aborted && pending.current === controller) setError(failure instanceof Error ? failure.message : t("ui.extensions.plugin-packages.couldNotPreviewPlugin")); }
    finally { if (pending.current === controller) { pending.current = null; setPreviewing(false); } }
  }
  const shown = catalog.filter(item => [item.manifest.name, item.manifest.description, item.manifest.id, localizeMessage(item.manifest.name), localizeMessage(item.manifest.description)].join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  return <section aria-label={mode === "market" ? t("ui.extensions.plugin-packages.riAPluginMarketplace") : t("ui.extensions.plugin-packages.installedPlugins")} className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-col gap-1"><h2 className="text-sm font-medium">{mode === "market" ? t("ui.extensions.extension-manager.pluginMarketplace") : tf("ui.extensions.plugin-packages.myPlugins", { v0: plugins.length })}</h2><p className="text-xs text-muted-foreground">{mode === "market" ? t("ui.extensions.plugin-packages.discoverCommunitySkillsAndRiABundles") : t("ui.extensions.plugin-packages.manageSkillsAndConnectionsTogetherEnable")}</p></div><Button id="plugin-import" size="sm" variant="ghost" disabled={busy || loading} onClick={event => show(event.currentTarget)}><Upload data-icon="inline-start" />{t("ui.extensions.plugin-packages.importPlugin")}</Button></div>
    {mode === "market" && <><SkillMarketplace plugins={plugins} busy={busy} actionError={actionError} onInstall={onInstall} /><div className="flex flex-col gap-1 pt-3"><h3 className="text-sm font-medium">{t("ui.extensions.plugin-packages.riAFeaturedPlugins")}</h3><p className="text-xs text-muted-foreground">{t("ui.extensions.plugin-packages.builtInBundlesOrImportAn")}</p></div><Field><FieldLabel className="sr-only" htmlFor="plugin-search">{t("ui.extensions.plugin-packages.searchPlugins")}</FieldLabel><ToolbarSearch id="plugin-search" placeholder={t("ui.extensions.plugin-packages.filterFeaturedPlugins")} value={search} onChange={event => setSearch(event.target.value)} /></Field></>}
    {loading ? <Skeleton className="h-28 rounded-xl" /> : mode === "market" ? <div className="flex flex-col gap-2">{shown.map(item => {
      const exists = plugins.some(plugin => plugin.packageId === item.manifest.id);
      return <article key={item.manifest.id} className="registry-result-row management-row flex items-start gap-3 rounded-xl p-4"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Package className="size-4" aria-hidden="true" /></div><div className="flex min-w-0 flex-1 flex-col gap-2"><h3 className="break-words text-sm font-medium">{localizeMessage(item.manifest.name)}</h3><p className="text-sm leading-6 text-muted-foreground">{localizeMessage(item.manifest.description)}</p><PluginContents manifest={item.manifest} /><Button size="sm" variant="ghost" className="self-start" disabled={busy || exists} onClick={event => show(event.currentTarget, item)}>{exists ? <><Check data-icon="inline-start" />{t("ui.extensions.plugin-packages.installed")}</> : <>{t("ui.extensions.plugin-packages.viewPlugin")}<ArrowRight data-icon="inline-end" /></>}</Button></div></article>;
    })}{!shown.length && <Empty><EmptyHeader><EmptyMedia><Search /></EmptyMedia><EmptyTitle>{t("ui.extensions.plugin-packages.noMatchingPlugins")}</EmptyTitle><EmptyDescription>{t("ui.extensions.plugin-packages.tryAnotherKeywordOrImportYour")}</EmptyDescription></EmptyHeader></Empty>}</div> : plugins.length ? <ul className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 6rem 5.5rem 2rem", "--cols-narrow": "minmax(0, 1fr) 5.5rem 5.5rem 2rem" } as React.CSSProperties}>{plugins.map(plugin => {
      const rows = connections.filter(row => row.pluginId === plugin.id);
      return <PluginRow key={plugin.id} plugin={plugin} name={catalog.some(item => item.digest === plugin.digest) ? localizeMessage(plugin.manifest.name) : plugin.manifest.name} incomplete={rows.length !== plugin.connections.length || rows.some(row => !ready(row))} busy={busy} onOpen={trigger => show(trigger, undefined, plugin)} onToggle={() => onToggle(plugin)} onUninstall={() => onUninstall(plugin)} />;
    })}</ul> : <Empty><EmptyHeader><EmptyMedia><Package /></EmptyMedia><EmptyTitle>{t("ui.extensions.plugin-packages.noPluginsInstalled")}</EmptyTitle><EmptyDescription>{t("ui.extensions.plugin-packages.chooseSkillsInPluginMarketplaceOr")}</EmptyDescription></EmptyHeader></Empty>}
    <Sheet open={open} onOpenChange={value => { if (!busy && !value) { pending.current?.abort(); draftVersion.current++; setOpen(false); } }}><SheetContent side="right" className="plugin-package-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel={t("ui.extensions.plugin-packages.closePluginDetails")} onCloseAutoFocus={event => { event.preventDefault(); if (!handoff.current) (opener.current?.isConnected ? opener.current : document.getElementById("plugin-import"))?.focus(); }}>
      <header className="flex shrink-0 flex-col gap-2 pr-8"><SheetTitle className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{(manifest ? previewText(manifest.name) : undefined) ?? t("ui.extensions.plugin-packages.importPlugin")}</SheetTitle><SheetDescription className="break-words text-xs [overflow-wrap:anywhere]">{manifest ? manifest.marketplace ? tf("ui.extensions.plugin-packages.skillsShSnapshot", { v0: manifest.marketplace.repository }) : `${manifest.author} · v${manifest.version} · ${manifest.id}` : t("ui.extensions.plugin-packages.chooseARiaPluginJsonFile")}</SheetDescription></header>
      <div className="chat-list-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
        {(error || actionError) && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-manager.operationIncomplete")}</AlertTitle><AlertDescription>{error || actionError}</AlertDescription></Alert>}
        {!current && !preview ? <FieldGroup><Field><FieldLabel htmlFor="plugin-file">{t("ui.extensions.plugin-packages.pluginPackageFile")}</FieldLabel><FileInput id="plugin-file" accept=".json,application/json" disabled={busy || previewing} onChange={event => void readFile(event.target.files?.[0])} buttonLabel={t("ui.extensions.plugin-packages.choosePluginPackage")} placeholder={t("ui.extensions.plugin-packages.riaPluginJsonUpTo2")} /></Field><Field><FieldLabel htmlFor="plugin-source">{t("ui.extensions.plugin-packages.pluginPackageJSON")}</FieldLabel><Textarea id="plugin-source" rows={8} value={source} disabled={busy} onChange={event => changeSource(event.target.value)} placeholder={'{"format":"ria-plugin","schemaVersion":1,…}'} /><FieldDescription>{t("ui.extensions.plugin-packages.onlyDeclarativeSkillsAndConnectionsAre")}</FieldDescription></Field><Button variant="secondary" disabled={busy || previewing || !source.trim()} className="self-start" onClick={() => void inspect()}>{previewing && <Loader2 data-icon="inline-start" className="animate-spin" />}{t("ui.extensions.plugin-packages.previewPlugin")}</Button></FieldGroup> : null}
        {!current && preview && source && <Button size="sm" variant="ghost" disabled={busy} className="self-start" onClick={() => { setPreview(null); setAllowLocal(false); }}>{t("ui.extensions.plugin-packages.editPackageContent")}</Button>}
        {manifest && <div className="plugin-preview flex flex-col gap-5"><p className="text-sm leading-7 text-muted-foreground">{previewText(manifest.description)}</p><PluginContents manifest={manifest} />{manifest.marketplace && <SkillFiles key={current?.id ?? preview?.digest} snapshot={manifest.marketplace} />}<section aria-label={t("ui.extensions.plugin-packages.pluginSkills")} className="flex flex-col gap-3"><h3 className="text-sm font-medium">{t("ui.extensions.plugin-packages.skills2")}</h3>{manifest.skills.length ? manifest.skills.map(skill => <details key={skill.id} className="settings-disclosure rounded-lg bg-muted/40 p-3"><summary className="settings-disclosure-trigger"><Sparkles className="size-4" aria-hidden="true" />{previewText(skill.name)}</summary><p className="py-2 text-xs leading-6 text-muted-foreground">{previewText(skill.description)}</p><pre className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{skill.instructions}</pre></details>) : <p className="text-xs text-muted-foreground">{t("ui.extensions.plugin-packages.thisPluginOnlyProvidesToolConnections")}</p>}</section>
          <section aria-label={t("ui.extensions.plugin-packages.pluginConnections")} className="flex flex-col gap-3"><h3 className="text-sm font-medium">{t("ui.extensions.plugin-packages.connectionsConfiguration")}</h3>{!manifest.connections.length && <p className="text-xs text-muted-foreground">{t("ui.extensions.plugin-packages.noServiceConnectionRequiredEnableThe")}</p>}{manifest.connections.map(connection => {
            const row = owned.find(item => item.id === current?.connections.find(item => item.key === connection.id)?.id);
            const config = row?.config ?? connection.config;
            return <div key={connection.id} className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{row?.name ?? connection.name}</h4><Badge variant="outline">{config.type === "http" ? "HTTP API" : config.type === "mcp-stdio" ? t("ui.extensions.plugin-packages.localProgram") : t("ui.extensions.plugin-packages.mCPService")}</Badge>{row && <Badge variant={ready(row) ? "success" : "secondary"}>{ready(row) ? t("ui.extensions.plugin-packages.ready") : t("ui.extensions.plugin-packages.needsConfigurationTesting")}</Badge>}</div><code className="break-all text-xs leading-6 text-muted-foreground">{config.type === "mcp-stdio" ? config.command : config.url}</code>{connection.credentials.map(field => <p key={field.key} className="break-words text-xs leading-6 text-muted-foreground">{field.key} · {field.required ? t("ui.extensions.plugin-packages.required") : t("ui.extensions.plugin-packages.optional")}{field.description ? ` · ${previewText(field.description)}` : ""}</p>)}{row && <div className="flex flex-wrap gap-1">{(["configure", "detect", "tools"] as const).map(action => <Button key={action} size="sm" variant="ghost" disabled={busy || (action === "tools" && !row.tools.length)} onClick={() => { handoff.current = true; setOpen(false); onConnection(action, row, opener.current); }}>{action === "configure" ? t("ui.extensions.plugin-packages.configureConnection") : action === "detect" ? t("ui.extensions.extension-manager.testConnection") : t("ui.extensions.extension-manager.manageTools")}</Button>)}</div>}</div>;
          })}</section>
          {!current && <p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.plugin-packages.disabledByDefaultAfterInstallationPlugins")}</p>}
          {!current && needsLocal && <><p className="text-xs text-muted-foreground">{localProcessesAllowed ? t("ui.extensions.plugin-packages.localProgramsRunWithCurrentUser") : t("ui.extensions.plugin-packages.pluginsWithLocalProgramsMustBe")}</p><Field orientation="horizontal"><input id="plugin-process-consent" type="checkbox" checked={allowLocal} onChange={event => setAllowLocal(event.target.checked)} disabled={busy || !localProcessesAllowed} /><FieldLabel htmlFor="plugin-process-consent">{t("ui.extensions.plugin-packages.iConfirmTheDeclaredLocalProgram")}</FieldLabel></Field></>}
        </div>}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => { pending.current?.abort(); draftVersion.current++; setOpen(false); }}>{t("window.close")}</Button>{current ? <Button disabled={busy || (!current.enabled && needsSetup)} onClick={() => onToggle(current)}><Power data-icon="inline-start" />{current.enabled ? t("ui.extensions.plugin-packages.disablePlugin") : t("ui.extensions.plugin-packages.enablePlugin")}</Button> : preview && <Button disabled={busy || previewing || (needsLocal && !allowLocal) || plugins.some(plugin => plugin.packageId === preview.manifest.id)} onClick={() => onInstall(preview, allowLocal, () => setOpen(false))}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}{t("ui.extensions.plugin-packages.installPlugin")}</Button>}</footer>
    </SheetContent></Sheet>
  </section>;
}

type RowProps = { plugin: PluginView; name: string; incomplete: boolean; busy: boolean; onOpen: (trigger: HTMLElement) => void; onToggle: () => void; onUninstall: () => void };
function PluginRow({ plugin, name, incomplete, busy, onOpen, onToggle, onUninstall }: RowProps) {
  useLocale();
  const actions = useRef<HTMLButtonElement>(null);
  const enabling = useRef(false);
  // The enable button leaves the row once the plugin is on; keep keyboard focus on the row's menu instead of dropping it.
  useEffect(() => { if (plugin.enabled && enabling.current) { enabling.current = false; actions.current?.focus(); } }, [plugin.enabled]);
  return <li {...removalKey(plugin.id)} data-testid={`plugin-${plugin.id}`} className="item-row data-row">
    <span className="item-row-icon"><Sparkles aria-hidden="true" /></span>
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="text-sm font-medium"><button type="button" className="item-row-open" onClick={event => onOpen(event.currentTarget)}>{name}</button></h3>
      <p className="truncate text-xs text-muted-foreground">{plugin.manifest.marketplace ? "skills.sh" : `v${plugin.manifest.version}`} · {plugin.manifest.skills.length} {t("ui.extensions.plugin-packages.skills")}{plugin.connections.length} {t("ui.extensions.plugin-packages.connections")}</p>
    </div>
    <Status tone={incomplete ? "warning" : plugin.enabled ? "success" : "neutral"}>{incomplete ? t("ui.extensions.extension-manager.configurationRequired") : plugin.enabled ? t("settings.schedules.on") : t("ui.chat.composer.disabled")}</Status>
    {plugin.enabled || incomplete ? <span /> : <Button size="sm" variant="ghost" className="item-row-action col-end" disabled={busy} onClick={() => { enabling.current = true; onToggle(); }}>{t("ui.extensions.plugin-packages.enablePlugin")}</Button>}
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger ref={actions} asChild><Button size="icon-sm" variant="ghost" className="item-row-action" aria-label={tf("ui.assistants.moreActionsFor", { v0: name })} disabled={busy}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!plugin.enabled && incomplete} onSelect={onToggle}><Power aria-hidden="true" />{plugin.enabled ? t("ui.extensions.plugin-packages.disablePlugin") : t("ui.extensions.plugin-packages.enablePlugin")}</DropdownMenuItem>
        <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onUninstall}><Trash2 aria-hidden="true" />{t("ui.confirm.uninstall")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </li>;
}

function PluginContents({ manifest }: { manifest: PluginManifest }) {
  useLocale();
  return <div className="flex flex-wrap gap-2"><Badge variant="secondary">{manifest.skills.length} {t("ui.extensions.plugin-packages.skills3")}</Badge><Badge variant="outline">{manifest.connections.length ? tf("ui.extensions.plugin-packages.toolConnections", { v0: manifest.connections.length }) : t("ui.extensions.plugin-packages.noExternalConnectionsRequired")}</Badge></div>;
}
