"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, Check, ChevronRight, Loader2, Plus, Power, Puzzle, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

export function ExtensionManager() {
  useLocale();
  const [data, setData] = useState<ExtensionData>({ items: [], encryptionAvailable: false, localProcessesAllowed: false });
  const [builtins, setBuiltins] = useState<ToolCatalogItem[]>([]);
  const [plugins, setPlugins] = useState<{ items: PluginView[]; catalog: PluginPreview[] }>({ items: [], catalog: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
  const returnFocus = () => { (opener.current?.isConnected ? opener.current : document.getElementById("extension-add"))?.focus(); };
  async function mutate(key: string, action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    loadRequest.current?.abort();
    const controller = new AbortController(); operation.current = controller; setBusy(key); setError(""); setNotice("");
    try { await action(controller.signal); }
    catch (failure) {
      if (!alive.current) return;
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : t("ui.extensions.extension-manager.extensionOperationFailed")); await load(false); }
      else { setNotice(t("ui.extensions.extension-manager.testCancelled")); await load(); }
    } finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy(""); } }
  }
  function detect(row: ExtensionView, trigger: HTMLElement | null) {
    void mutate(`${row.id}:test`, async signal => {
      const updated = await request<ExtensionView>(`/api/extensions/${row.id}/test`, signal, "POST", { revision: row.revision });
      upsert(updated); openTools(updated, trigger ?? document.getElementById("plugin-import")!);
      setNotice(updated.tools.length ? t("ui.extensions.extension-manager.connectionSuccessfulConfirmWhichToolsTo") : t("ui.extensions.extension-manager.connectionSuccessfulThisServiceProvidesNo"));
    });
  }
  const packageProps = {
    plugins: plugins.items, catalog: plugins.catalog, connections: data.items, busy: !!busy, loading, actionError: error, localProcessesAllowed: data.localProcessesAllowed,
    onInstall: (preview: PluginPreview, allowLocalProcesses: boolean, onInstalled: () => void) => void mutate("plugin:install", async signal => {
      const installed = await request<PluginView>("/api/plugins", signal, "POST", { ...preview, allowLocalProcesses });
      setPlugins(old => ({ ...old, items: [...old.items, installed] }));
      await load(false); onInstalled(); setTab("mine"); setNotice(installed.connections.length ? t("ui.extensions.extension-manager.pluginInstalledOpenItToConfigure") : t("ui.extensions.extension-manager.pluginInstalledEnableItToUse"));
    }),
    onToggle: (plugin: PluginView) => void mutate(`plugin:${plugin.id}`, async signal => {
      await request(`/api/plugins/${plugin.id}`, signal, "PATCH", { revision: plugin.revision, enabled: !plugin.enabled });
      await load(false); setNotice(plugin.enabled ? t("ui.extensions.extension-manager.pluginDisabledItsToolsAndSkill") : t("ui.extensions.extension-manager.pluginEnabledChatCanUseIts"));
    }),
    onUninstall: (plugin: PluginView) => { if (window.confirm(tf("ui.extensions.extension-manager.uninstallAndItsConnectionsChatHistory", { v0: plugin.manifest.name }))) void mutate(`plugin:${plugin.id}:remove`, async signal => {
      await request(`/api/plugins/${plugin.id}?revision=${plugin.revision}`, signal, "DELETE");
      setPlugins(old => ({ ...old, items: old.items.filter(item => item.id !== plugin.id) }));
      setData(old => ({ ...old, items: old.items.filter(item => item.pluginId !== plugin.id) }));
      setNotice(t("ui.extensions.extension-manager.pluginAndItsConnectionsUninstalled"));
    }); },
    onConnection: (action: "configure" | "detect" | "tools", row: ExtensionView, trigger: HTMLElement | null) => {
      if (action === "configure") openEditor(row, undefined, trigger);
      else if (action === "detect") detect(row, trigger);
      else { opener.current = trigger; setToolSheet(row); setToolsSession(value => value + 1); setToolsOpen(true); }
    },
  };
  const standalone = data.items.filter(item => !item.pluginId);
  const enabledCount = standalone.filter(item => item.enabled).length;
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-7 px-4 py-8 md:px-6">
    <header className="workspace-page-header"><div className="flex flex-col gap-2"><h1>{t("ui.layout.app-shell.extensions")}</h1><p className="text-sm text-muted-foreground">{t("ui.extensions.extension-manager.installPluginsToAddSkillsAnd")}</p></div><div className="flex items-center gap-2">{tab === "mine" && <Button size="sm" variant="ghost" disabled={loading || !!busy} onClick={() => void load()}><RefreshCw data-icon="inline-start" />{t("knowledge.refresh")}</Button>}<Button id="extension-add" size="sm" disabled={loading || !!busy || data.items.length >= 20} onClick={() => openEditor("new")}><Plus data-icon="inline-start" />{t("ui.extensions.extension-editor.addExtension")}</Button></div></header>
    {error && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-manager.operationIncomplete")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{localizeMessage(notice)}</p>}
    {data.items.some(row => row.pluginId && busy === `${row.id}:test`) && <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">{t("ui.extensions.extension-manager.testingPluginConnection")}<Button variant="ghost" size="sm" onClick={() => operation.current?.abort()}>{t("ui.extensions.extension-manager.cancelTest")}</Button></div>}
    <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-5">
      <TabsList aria-label={t("ui.extensions.extension-manager.extensionViews")} className="self-start"><TabsTrigger value="mine">{t("ui.extensions.extension-manager.myExtensions")}</TabsTrigger><TabsTrigger value="market">{t("ui.extensions.extension-manager.pluginMarketplace")}</TabsTrigger><TabsTrigger value="discover">{t("ui.extensions.extension-discovery.discoverExtensions")}</TabsTrigger></TabsList>
      <TabsContent value="market"><PluginPackages mode="market" {...packageProps} /></TabsContent>
      <TabsContent value="discover"><ExtensionDiscovery canAdd={!loading && !busy && data.items.length < 20} connectedUrls={data.items.flatMap(item => item.config.type === "mcp-http" ? [item.config.url] : [])} onAdd={(draft, trigger) => openEditor("new", draft, trigger)} /></TabsContent>
      <TabsContent value="mine" className="flex flex-col gap-5">
    <PluginPackages mode="installed" {...packageProps} />
    <section aria-label={t("ui.extensions.extension-manager.configuredExtensions")} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{t("ui.extensions.extension-manager.standaloneConnections")}<span className="ml-2 text-muted-foreground">{standalone.length}</span></h2><span className="text-xs text-muted-foreground">{enabledCount} {t("ui.extensions.extension-manager.confirmed")}</span></div>
      {loading ? <><Skeleton className="h-36" /><Skeleton className="h-36" /></> : !standalone.length ? <Empty><EmptyHeader><EmptyMedia><Puzzle /></EmptyMedia><EmptyTitle>{t("ui.extensions.extension-manager.connectYourFirstExtension")}</EmptyTitle><EmptyDescription>{t("ui.extensions.extension-manager.addAnMCPServiceOrHTTP")}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => openEditor("new")}><Plus data-icon="inline-start" />{t("ui.extensions.extension-editor.addExtension")}</Button></Empty> : standalone.map(row => <Card key={row.id} data-testid={`extension-${row.id}`}>
        <CardHeader className="flex-row items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Cable className="size-4" aria-hidden="true" /></div><div className="flex min-w-0 flex-1 flex-col gap-1"><CardTitle className="break-words [overflow-wrap:anywhere]">{row.name}</CardTitle><CardDescription className="truncate" title={connectionLabel(row)}>{connectionLabel(row)}</CardDescription></div><Badge className="shrink-0" variant={row.error ? "danger" : row.enabled ? "success" : "secondary"}>{stateLabel(row)}</Badge></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2"><Badge variant="outline">{labels()[row.config.type]}</Badge><span className="text-xs text-muted-foreground">{row.tools.filter(tool => tool.enabled).length} / {row.tools.length} {t("ui.extensions.extension-manager.toolsSelected")}</span>{row.hasCredentials && <span className="text-xs text-muted-foreground">{t("ui.extensions.extension-manager.credentialsConfigured")}</span>}{row.error && <p className="w-full break-words text-xs text-destructive">{row.error}</p>}</CardContent>
        <CardFooter className="flex-wrap gap-1"><Button size="sm" variant="ghost" disabled={!!busy} onClick={event => { const trigger = event.currentTarget; void mutate(`${row.id}:test`, async signal => { const updated = await request<ExtensionView>(`/api/extensions/${row.id}/test`, signal, "POST", { revision: row.revision }); upsert(updated); openTools(updated, trigger); setNotice(updated.tools.length ? t("ui.extensions.extension-manager.connectionSuccessfulConfirmWhichToolsTo") : t("ui.extensions.extension-manager.connectionSuccessfulThisServiceProvidesNo")); }); }}>{busy === `${row.id}:test` ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}{t("ui.extensions.extension-manager.testConnection")}</Button><Button size="sm" variant="ghost" disabled={!!busy || !row.tools.length} onClick={event => openTools(row, event.currentTarget)}>{t("ui.extensions.extension-manager.manageTools")}<ChevronRight data-icon="inline-end" /></Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => openEditor(row)}><Settings2 data-icon="inline-start" />{t("ui.extensions.extension-manager.configure")}</Button>{row.enabled && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void mutate(`${row.id}:disable`, async signal => { upsert(await request<ExtensionView>(`/api/extensions/${row.id}`, signal, "PATCH", { revision: row.revision, enabled: false, tools: row.tools.filter(tool => tool.enabled).map(tool => tool.name) })); setNotice(t("ui.extensions.extension-manager.extensionDisabledNewToolCallsWill")); })}><Power data-icon="inline-start" />{t("ui.extensions.extension-manager.disable")}</Button>}{!row.pluginId && <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={tf("ui.extensions.extension-manager.deleteExtension", { v0: row.name })} disabled={!!busy} onClick={() => { if (window.confirm(tf("ui.extensions.extension-manager.deleteExtensionConnectionSettingsAndCredentials", { v0: row.name }))) void mutate(`${row.id}:delete`, async signal => { await request(`/api/extensions/${row.id}?revision=${row.revision}`, signal, "DELETE"); setData(old => ({ ...old, items: old.items.filter(item => item.id !== row.id) })); setNotice(t("ui.extensions.extension-manager.extensionDeleted")); }); }}><Trash2 /></Button>}</CardFooter>
        {busy === `${row.id}:test` && <CardFooter><Button size="sm" variant="outline" onClick={() => operation.current?.abort()}>{t("ui.extensions.extension-manager.cancelTest")}</Button></CardFooter>}
      </Card>)}
    </section>
    <details className="settings-disclosure"><summary className="settings-disclosure-trigger">{t("ui.extensions.extension-manager.builtInTools")}<Badge variant="secondary">{builtins.length}</Badge><ChevronRight className="ml-auto size-4" aria-hidden="true" /></summary><div className="flex flex-col gap-3 py-4">{builtins.map(tool => <div className="flex items-center justify-between gap-3 px-1" key={tool.id}><div className="flex min-w-0 flex-col gap-1"><span className="text-sm">{localizeMessage(tool.displayName)}</span><span className="text-xs text-muted-foreground">{localizeMessage(tool.description)}</span></div><Badge variant={tool.available ? "success" : "outline"}>{tool.available ? t("models.availability.ready") : tool.reason === "noDirectoryGranted" ? t("ui.extensions.extension-manager.directoryAccessRequired") : t("ui.extensions.extension-manager.configurationRequired")}</Badge></div>)}</div></details>
    <p className="text-xs leading-6 text-muted-foreground">{t("ui.extensions.extension-manager.enabledExternalToolsCanBeCalled")}<Link className="ml-1 underline underline-offset-4" href="/assistants">{t("ui.extensions.extension-manager.selectToolsInAssistantTemplates")}</Link>{t("ui.extensions.extension-manager.extensionConfigurationStaysOnThisDevice")}</p>
      </TabsContent>
    </Tabs>
    {editor !== null && <ExtensionEditor key={editorSession} open={editorOpen} returnFocus={returnFocus} draft={registryDraft} row={editor === "new" ? null : editor} encryptionAvailable={data.encryptionAvailable} localProcessesAllowed={data.localProcessesAllowed} onClose={() => setEditorOpen(false)} onSaved={row => { upsert(row); setEditorOpen(false); setTab("mine"); setNotice(t("ui.extensions.extension-manager.configurationSavedTestTheConnectionChanges")); }} />}
    {toolSheet && <ExtensionTools key={toolsSession} open={toolsOpen} returnFocus={returnFocus} error={localizeMessage(error)} row={toolSheet} busy={!!busy} onClose={() => setToolsOpen(false)} onSave={selected => void mutate(`${toolSheet.id}:activate`, async signal => { const updated = await request<ExtensionView>(`/api/extensions/${toolSheet.id}`, signal, "PATCH", { revision: toolSheet.revision, enabled: true, tools: selected }); upsert(updated); setToolsOpen(false); setNotice(t("ui.extensions.extension-manager.selectedToolsEnabledAndAvailableIn")); })} />}
  </main>;
}

function ExtensionTools({ row, open, returnFocus, error, busy, onClose, onSave }: { open: boolean; returnFocus: () => void; error: string; row: ExtensionView; busy: boolean; onClose: () => void; onSave: (selected: string[]) => void }) {
  useLocale();
  const [selected, setSelected] = useState(() => row.tools.filter(tool => tool.enabled).map(tool => tool.name));
  return <Sheet open={open} onOpenChange={next => { if (!next && !busy) onClose(); }}><SheetContent side="right" className="extension-editor flex flex-col" closeLabel={t("ui.extensions.extension-manager.closeToolManagement")} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}><header className="flex shrink-0 flex-col gap-2 px-6 pb-4 pt-7 pr-14"><SheetTitle className="break-words [overflow-wrap:anywhere]">{row.name} {t("ui.extensions.extension-manager.tools")}</SheetTitle><SheetDescription>{t("ui.extensions.extension-manager.enableOnlyTheToolsYouNeed")}</SheetDescription>{error && <Alert variant="destructive"><AlertTitle>{t("ui.extensions.extension-manager.notUpdated")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert>}</header><div className="chat-list-scroll min-h-0 flex-1 overflow-y-auto px-6"><FieldSet disabled={busy}><FieldLegend>{t("ui.extensions.extension-manager.availableTools")}{row.tools.length}</FieldLegend><FieldGroup className="gap-4">{row.tools.map(tool => <Field key={tool.name} orientation="horizontal"><input id={`extension-tool-${tool.id}`} type="checkbox" checked={selected.includes(tool.name)} onChange={event => setSelected(old => event.target.checked ? [...old, tool.name] : old.filter(name => name !== tool.name))} /><div className="flex min-w-0 flex-1 flex-col gap-1"><FieldLabel className="break-all" htmlFor={`extension-tool-${tool.id}`}>{tool.name}</FieldLabel><p className="break-words text-xs leading-5 text-muted-foreground">{localizeMessage(tool.description)}</p><details className="settings-disclosure"><summary className="settings-disclosure-trigger">{t("ui.extensions.extension-manager.parameterFormat")}</summary><pre className="chat-list-scroll overflow-x-auto whitespace-pre-wrap break-all pb-3 text-xs text-muted-foreground">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div></Field>)}</FieldGroup></FieldSet></div><footer className="flex shrink-0 items-center justify-between gap-2 px-6 py-4"><span className="text-xs text-muted-foreground">{t("chat.composer.selectedAttachmentsPrefix")}{selected.length} {t("conversations.counts.loadedUnit")}</span><Button disabled={busy || !row.tested || !selected.length} onClick={() => onSave(selected)}>{busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{row.enabled ? t("ui.extensions.extension-manager.saveToolSelection") : t("ui.extensions.extension-manager.enableSelectedTools")}</Button></footer></SheetContent></Sheet>;
}
