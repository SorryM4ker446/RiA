"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, Check, ChevronRight, ListChecks, Loader2, MoreHorizontal, Plus, Power, Puzzle, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Status } from "@/components/ui/status";
import { PageHeader } from "@/components/layout/page-header";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getApiErrorMessage } from "@/lib/api-error-message";
import type { ExtensionView } from "@/lib/extensions/store";
import type { ToolCatalogItem } from "@/features/chat/types";
import { ExtensionEditor } from "./extension-editor";
import { ExtensionDiscovery } from "./extension-discovery";
import type { RegistryConnectionDraft } from "@/lib/extensions/registry-types";
import { PluginPackages } from "./plugin-packages";
import type { PluginPreview, PluginView } from "@/lib/plugins/types";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { useConfirm } from "@/components/ui/confirm-dialog";

type ExtensionData = { items: ExtensionView[]; encryptionAvailable: boolean; localProcessesAllowed: boolean };
async function request<T>(url: string, signal: AbortSignal, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", signal, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, t("ui.extensions.extension-manager.extensionOperationFailed")));
  return payload.data;
}
const labels = () => ({ "mcp-http": t("ui.extensions.extension-manager.mCPRemote"), "mcp-stdio": t("ui.extensions.extension-manager.mCPLocal"), http: "HTTP API" });
function connectionLabel(row: ExtensionView) { return row.config.type === "mcp-stdio" ? row.config.command : row.config.url; }
function stateLabel(row: ExtensionView) { return !row.credentialsAvailable ? t("ui.chat.composer.credentialsUnavailable") : row.error ? t("ui.extensions.extension-manager.connectionFailed") : row.enabled ? t("settings.schedules.on") : row.tested ? t("ui.chat.composer.disabled") : t("ui.chat.composer.notTested"); }
function stateTone(row: ExtensionView) { return !row.credentialsAvailable ? "warning" : row.error ? "danger" : row.enabled ? "success" : "neutral"; }

export function ExtensionManager() {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState<ExtensionData>({ items: [], encryptionAvailable: false, localProcessesAllowed: false });
  const [builtins, setBuiltins] = useState<ToolCatalogItem[]>([]);
  const [plugins, setPlugins] = useState<{ items: PluginView[]; catalog: PluginPreview[] }>({ items: [], catalog: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editor, setEditor] = useState<ExtensionView | "new" | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSession, setEditorSession] = useState(0);
  const [toolSheet, setToolSheet] = useState<ExtensionView | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsSession, setToolsSession] = useState(0);
  const [tab, setTab] = useState("mine");
  const [registryDraft, setRegistryDraft] = useState<RegistryConnectionDraft | undefined>();
  const opener = useRef<HTMLElement | null>(null);
  const operation = useRef<AbortController | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const load = useCallback(async (clearError = true) => {
    loadRequest.current?.abort(); const controller = new AbortController(); loadRequest.current = controller;
    try {
      const [extensions, tools, packages] = await Promise.all([request<ExtensionData>("/api/extensions", controller.signal), request<ToolCatalogItem[]>("/api/tools?mode=chat", controller.signal), request<typeof plugins>("/api/plugins", controller.signal)]);
      if (!controller.signal.aborted) { setData(extensions); setPlugins(packages); setBuiltins(tools.filter(tool => !tool.extensionId)); if (clearError) setError(""); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.extensions.extension-manager.couldNotLoadExtensions")); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; loadRequest.current?.abort(); operation.current?.abort(); }; }, [load]);

  const upsert = (row: ExtensionView) => setData(old => ({ ...old, items: old.items.some(item => item.id === row.id) ? old.items.map(item => item.id === row.id ? row : item) : [...old.items, row] }));
  function openEditor(row: ExtensionView | "new", draft?: RegistryConnectionDraft, trigger?: HTMLElement | null) { opener.current = trigger ?? document.activeElement as HTMLElement; setRegistryDraft(draft); setEditor(row); setEditorSession(old => old + 1); setEditorOpen(true); }
  function openTools(row: ExtensionView, trigger: HTMLElement) { opener.current = trigger; setToolSheet(row); setToolsSession(old => old + 1); setToolsOpen(true); }
  // A row's next-step button leaves once that step is done; its menu button is the closest place to return to.
  const returnFocus = (rowId?: string) => { (opener.current?.isConnected ? opener.current : (rowId && document.getElementById(`extension-actions-${rowId}`)) || document.getElementById("extension-add"))?.focus(); };
  async function mutate(key: string, action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    loadRequest.current?.abort();
    const controller = new AbortController(); operation.current = controller; setBusy(key); setError("");
    try { await action(controller.signal); }
    catch (failure) {
      if (!alive.current) return;
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : t("ui.extensions.extension-manager.extensionOperationFailed")); await load(false); }
      else { toast(t("ui.extensions.extension-manager.testCancelled")); await load(); }
    } finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(""); } }
  }
  function detect(row: ExtensionView, trigger: HTMLElement | null) {
    void mutate(`${row.id}:test`, async signal => {
      const updated = await request<ExtensionView>(`/api/extensions/${row.id}/test`, signal, "POST", { revision: row.revision });
      upsert(updated); openTools(updated, trigger ?? document.getElementById("plugin-import")!);
      toast(updated.tools.length ? t("ui.extensions.extension-manager.connectionSuccessfulConfirmWhichToolsTo") : t("ui.extensions.extension-manager.connectionSuccessfulThisServiceProvidesNo"));
    });
  }
  function disable(row: ExtensionView) {
    void mutate(`${row.id}:disable`, async signal => { upsert(await request<ExtensionView>(`/api/extensions/${row.id}`, signal, "PATCH", { revision: row.revision, enabled: false, tools: row.tools.filter(tool => tool.enabled).map(tool => tool.name) })); toast(t("ui.extensions.extension-manager.extensionDisabledNewToolCallsWill")); });
  }
  async function remove(row: ExtensionView) {
    if (await confirm({ title: t("ui.confirm.deleteExtension"), description: tf("ui.extensions.extension-manager.deleteExtensionConnectionSettingsAndCredentials", { v0: row.name }), action: t("ui.confirm.delete"), destructive: true })) void mutate(`${row.id}:delete`, async signal => { await request(`/api/extensions/${row.id}?revision=${row.revision}`, signal, "DELETE"); await animateRemoval(row.id, () => setData(old => ({ ...old, items: old.items.filter(item => item.id !== row.id) }))); toast(t("ui.extensions.extension-manager.extensionDeleted")); });
  }
  const packageProps = {
    plugins: plugins.items, catalog: plugins.catalog, connections: data.items, busy: !!busy, loading, actionError: error, localProcessesAllowed: data.localProcessesAllowed,
    onInstall: (preview: PluginPreview, allowLocalProcesses: boolean, onInstalled: () => void) => void mutate("plugin:install", async signal => {
      const installed = await request<PluginView>("/api/plugins", signal, "POST", { ...preview, allowLocalProcesses });
      setPlugins(old => ({ ...old, items: [...old.items, installed] }));
      await load(false); onInstalled(); setTab("mine"); toast(installed.connections.length ? t("ui.extensions.extension-manager.pluginInstalledOpenItToConfigure") : t("ui.extensions.extension-manager.pluginInstalledEnableItToUse"));
    }),
    onToggle: (plugin: PluginView) => void mutate(`plugin:${plugin.id}`, async signal => {
      await request(`/api/plugins/${plugin.id}`, signal, "PATCH", { revision: plugin.revision, enabled: !plugin.enabled });
      await load(false); toast(plugin.enabled ? t("ui.extensions.extension-manager.pluginDisabledItsToolsAndSkill") : t("ui.extensions.extension-manager.pluginEnabledChatCanUseIts"));
    }),
    onUninstall: async (plugin: PluginView) => { if (await confirm({ title: t("ui.confirm.uninstallPlugin"), description: tf("ui.extensions.extension-manager.uninstallAndItsConnectionsChatHistory", { v0: plugin.manifest.name }), action: t("ui.confirm.uninstall"), destructive: true })) void mutate(`plugin:${plugin.id}:remove`, async signal => {
      await request(`/api/plugins/${plugin.id}?revision=${plugin.revision}`, signal, "DELETE");
      await animateRemoval(plugin.id, () => {
        setPlugins(old => ({ ...old, items: old.items.filter(item => item.id !== plugin.id) }));
        setData(old => ({ ...old, items: old.items.filter(item => item.pluginId !== plugin.id) }));
      });
      toast(t("ui.extensions.extension-manager.pluginAndItsConnectionsUninstalled"));
    }); },
    onConnection: (action: "configure" | "detect" | "tools", row: ExtensionView, trigger: HTMLElement | null) => {
      if (action === "configure") openEditor(row, undefined, trigger);
      else if (action === "detect") detect(row, trigger);
      else { opener.current = trigger; setToolSheet(row); setToolsSession(value => value + 1); setToolsOpen(true); }
    },
  };
  const standalone = data.items.filter(item => !item.pluginId);
  const enabledCount = standalone.filter(item => item.enabled).length;
  return <>
    <PageHeader level={2} title={t("ui.settingsOverlay.extensions")} description={t("ui.extensions.extension-manager.installPluginsToAddSkillsAnd")} actions={<>{tab === "mine" && <RefreshButton iconOnly disabled={loading || !!busy} onClick={() => void load()} label={t("knowledge.refresh")} />}<Button id="extension-add" size="sm" disabled={loading || !!busy || data.items.length >= 20} onClick={() => openEditor("new")}><Plus data-icon="inline-start" />{t("ui.extensions.extension-editor.addExtension")}</Button></>} />
    <Reveal className="-mt-7">{error ? <Alert variant="destructive" className="mt-7"><AlertTitle>{t("ui.extensions.extension-manager.operationIncomplete")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}</Reveal>
    <Reveal className="-mt-7">{data.items.some(row => row.pluginId && busy === `${row.id}:test`) ? <div role="status" className="mt-7 flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t("ui.extensions.extension-manager.testingPluginConnection")}<Button variant="ghost" size="sm" onClick={() => operation.current?.abort()}>{t("ui.extensions.extension-manager.cancelTest")}</Button></div> : null}</Reveal>
    <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-5">
      <TabsList aria-label={t("ui.extensions.extension-manager.extensionViews")} className="self-start"><TabsTrigger value="mine">{t("ui.extensions.extension-manager.myExtensions")}</TabsTrigger><TabsTrigger value="market">{t("ui.extensions.extension-manager.pluginMarketplace")}</TabsTrigger><TabsTrigger value="discover">{t("ui.extensions.extension-discovery.discoverExtensions")}</TabsTrigger></TabsList>
      <TabsContent value="market"><PluginPackages mode="market" {...packageProps} /></TabsContent>
      <TabsContent value="discover"><ExtensionDiscovery canAdd={!loading && !busy && data.items.length < 20} connectedUrls={data.items.flatMap(item => item.config.type === "mcp-http" ? [item.config.url] : [])} onAdd={(draft, trigger) => openEditor("new", draft, trigger)} /></TabsContent>
      <TabsContent value="mine" className="flex flex-col gap-5">
    {/* One placeholder for the whole view: the lists' loaded heights are unknown until they
        arrive, so a placeholder per list would push everything below it once they do. */}
    {loading ? <Skeleton className="h-72 rounded-xl" /> : <>
    <PluginPackages mode="installed" {...packageProps} />
    <section aria-label={t("ui.extensions.extension-manager.configuredExtensions")} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{t("ui.extensions.extension-manager.standaloneConnections")}<span className="ml-2 text-muted-foreground">{standalone.length}</span></h2><span className="text-xs text-muted-foreground">{enabledCount} {t("ui.extensions.extension-manager.confirmed")}</span></div>
      {!standalone.length ?<Empty><EmptyHeader><EmptyMedia><Puzzle /></EmptyMedia><EmptyTitle>{t("ui.extensions.extension-manager.connectYourFirstExtension")}</EmptyTitle><EmptyDescription>{t("ui.extensions.extension-manager.addAnMCPServiceOrHTTP")}</EmptyDescription></EmptyHeader><Button size="sm" variant="ghost" onClick={() => openEditor("new")}><Plus data-icon="inline-start" />{t("ui.extensions.extension-editor.addExtension")}</Button></Empty> : <ul className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 6rem 5.5rem 2rem", "--cols-narrow": "minmax(0, 1fr) 5.5rem 5.5rem 2rem" } as React.CSSProperties}>{standalone.map(row => <ExtensionRow key={row.id} row={row} busy={!!busy} testing={busy === `${row.id}:test`} onOpen={trigger => openEditor(row, undefined, trigger)} onDetect={trigger => detect(row, trigger)} onTools={trigger => openTools(row, trigger)} onCancel={() => operation.current?.abort()} onDisable={() => disable(row)} onDelete={() => void remove(row)} />)}</ul>}
    </section>
    <details className="settings-disclosure"><summary className="settings-disclosure-trigger">{t("ui.extensions.extension-manager.builtInTools")}<Badge variant="secondary">{builtins.length}</Badge><ChevronRight className="ml-auto size-4" aria-hidden="true" /></summary><div className="flex flex-col gap-3 py-4">{builtins.map(tool => <div className="flex items-center justify-between gap-3 px-1" key={tool.id}><div className="flex min-w-0 flex-col gap-1"><span className="text-sm">{localizeMessage(tool.displayName)}</span><span className="text-xs text-muted-foreground">{localizeMessage(tool.description)}</span></div><Status tone={tool.available ? "success" : "neutral"}>{tool.available ? t("models.availability.ready") : tool.reason === "noDirectoryGranted" ? t("ui.extensions.extension-manager.directoryAccessRequired") : t("ui.extensions.extension-manager.configurationRequired")}</Status></div>)}</div></details>
    <p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.extension-manager.enabledExternalToolsCanBeCalled")}<Link className="ml-1 underline underline-offset-4" href="/assistants">{t("ui.extensions.extension-manager.selectToolsInAssistantTemplates")}</Link>{t("ui.extensions.extension-manager.extensionConfigurationStaysOnThisDevice")}</p>
    </>}
      </TabsContent>
    </Tabs>
    {editor !== null && <ExtensionEditor key={editorSession} open={editorOpen} returnFocus={returnFocus} draft={registryDraft} row={editor === "new" ? null : editor} encryptionAvailable={data.encryptionAvailable} localProcessesAllowed={data.localProcessesAllowed} onClose={() => setEditorOpen(false)} onSaved={row => { upsert(row); setEditorOpen(false); setTab("mine"); toast(t("ui.extensions.extension-manager.configurationSavedTestTheConnectionChanges")); }} />}
    {toolSheet && <ExtensionTools key={toolsSession} open={toolsOpen} returnFocus={() => returnFocus(toolSheet.id)} error={localizeMessage(error)} row={toolSheet} busy={!!busy} onClose={() => setToolsOpen(false)} onSave={selected => void mutate(`${toolSheet.id}:activate`, async signal => { const updated = await request<ExtensionView>(`/api/extensions/${toolSheet.id}`, signal, "PATCH", { revision: toolSheet.revision, enabled: true, tools: selected }); upsert(updated); setToolsOpen(false); toast(t("ui.extensions.extension-manager.selectedToolsEnabledAndAvailableIn")); })} />}
  </>;
}

type RowProps = { row: ExtensionView; busy: boolean; testing: boolean; onOpen: (trigger: HTMLElement) => void; onDetect: (trigger: HTMLElement | null) => void; onTools: (trigger: HTMLElement) => void; onCancel: () => void; onDisable: () => void; onDelete: () => void };
function ExtensionRow({ row, busy, testing, onOpen, onDetect, onTools, onCancel, onDisable, onDelete }: RowProps) {
  useLocale();
  const actions = useRef<HTMLButtonElement>(null);
  // Only the step that brings this connection into use stays on the row; everything else waits in the menu.
  const next = row.error || !row.tested ? "detect" : !row.enabled && row.tools.length ? "tools" : null;
  return <li {...removalKey(row.id)} data-testid={`extension-${row.id}`} className="item-row data-row">
    <span className="item-row-icon"><Cable aria-hidden="true" /></span>
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3 className="text-sm font-medium"><button type="button" className="item-row-open" disabled={busy} onClick={event => onOpen(event.currentTarget)}>{row.name}</button></h3>
      <p className="truncate text-xs text-muted-foreground" title={connectionLabel(row)}>{labels()[row.config.type]} · {row.tools.filter(tool => tool.enabled).length} / {row.tools.length} {t("ui.extensions.extension-manager.toolsSelected")} · {connectionLabel(row)}</p>
      {row.error && <p className="break-words text-xs text-destructive">{row.error}</p>}
    </div>
    <Status tone={stateTone(row)}>{stateLabel(row)}</Status>
    {testing ? <Button size="sm" variant="ghost" className="item-row-action col-end" onClick={onCancel}><Loader2 data-icon="inline-start" className="animate-spin" />{t("ui.extensions.extension-manager.cancelTest")}</Button> : !next ? <span /> : <Button size="sm" variant="ghost" className="item-row-action col-end" disabled={busy} onClick={event => next === "detect" ? onDetect(event.currentTarget) : onTools(event.currentTarget)}>{next === "detect" ? t("ui.extensions.extension-manager.testConnection") : t("ui.extensions.extension-manager.manageTools")}</Button>}
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger ref={actions} asChild><Button id={`extension-actions-${row.id}`} size="icon-sm" variant="ghost" className="item-row-action" aria-label={tf("ui.assistants.moreActionsFor", { v0: row.name })} disabled={busy}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup>
        <DropdownMenuItem onSelect={() => onOpen(actions.current!)}><Settings2 aria-hidden="true" />{t("ui.extensions.extension-manager.configure")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onDetect(actions.current)}><RefreshCw aria-hidden="true" />{t("ui.extensions.extension-manager.testConnection")}</DropdownMenuItem>
        <DropdownMenuItem disabled={!row.tools.length} onSelect={() => onTools(actions.current!)}><ListChecks aria-hidden="true" />{t("ui.extensions.extension-manager.manageTools")}</DropdownMenuItem>
        {row.enabled && <DropdownMenuItem onSelect={onDisable}><Power aria-hidden="true" />{t("ui.extensions.extension-manager.disable")}</DropdownMenuItem>}
      </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 aria-hidden="true" />{t("ui.confirm.delete")}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </li>;
}

function ExtensionTools({ row, open, returnFocus, error, busy, onClose, onSave }: { open: boolean; returnFocus: () => void; error: string; row: ExtensionView; busy: boolean; onClose: () => void; onSave: (selected: string[]) => void }) {
  useLocale();
  const [selected, setSelected] = useState(() => row.tools.filter(tool => tool.enabled).map(tool => tool.name));
  return <Sheet open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><SheetContent side="right" className="extension-editor flex flex-col" closeLabel={t("ui.extensions.extension-manager.closeToolManagement")} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}><header className="flex shrink-0 flex-col gap-2 px-6 pb-4 pt-7 pr-14"><SheetTitle className="break-words [overflow-wrap:anywhere]">{row.name} {t("ui.extensions.extension-manager.tools")}</SheetTitle><SheetDescription>{t("ui.extensions.extension-manager.enableOnlyTheToolsYouNeed")}</SheetDescription>{error && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-manager.notUpdated")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert>}</header><div className="chat-list-scroll min-h-0 flex-1 overflow-y-auto px-6"><FieldSet disabled={busy}><FieldLegend>{t("ui.extensions.extension-manager.availableTools")}{row.tools.length}</FieldLegend><FieldGroup className="gap-4">{row.tools.map(tool => <Field key={tool.name} orientation="horizontal"><input id={`extension-tool-${tool.id}`} type="checkbox" checked={selected.includes(tool.name)} onChange={event => setSelected(old => event.target.checked ? [...old, tool.name] : old.filter(name => name !== tool.name))} /><div className="flex min-w-0 flex-1 flex-col gap-1"><FieldLabel className="break-all" htmlFor={`extension-tool-${tool.id}`}>{tool.name}</FieldLabel><p className="break-words text-xs leading-5 text-muted-foreground">{localizeMessage(tool.description)}</p><details className="settings-disclosure"><summary className="settings-disclosure-trigger">{t("ui.extensions.extension-manager.parameterFormat")}</summary><pre className="chat-list-scroll overflow-x-auto whitespace-pre-wrap break-all pb-3 text-xs text-muted-foreground">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div></Field>)}</FieldGroup></FieldSet></div><footer className="flex shrink-0 items-center justify-between gap-2 px-6 py-4"><span className="text-xs text-muted-foreground">{t("chat.composer.selectedAttachmentsPrefix")}{selected.length} {t("conversations.counts.loadedUnit")}</span><Button disabled={busy || !row.tested || !selected.length} onClick={() => onSave(selected)}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{row.enabled ? t("ui.extensions.extension-manager.saveToolSelection") : t("ui.extensions.extension-manager.enableSelectedTools")}</Button></footer></SheetContent></Sheet>;
}
