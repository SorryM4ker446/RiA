"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Copy, CopyPlus, MessageSquarePlus, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { TemplateEditor } from "@/features/assistants/template-editor";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { writeToClipboard } from "@/lib/clipboard";
import { assistantConfigSchema, type AssistantConfig, type AssistantTemplate } from "@/lib/assistants/schema";
import { DEFAULT_ASSISTANTS } from "@/lib/assistants/defaults";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";
import { chatApi } from "@/features/chat/api-client";
import { LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { useConfirm } from "@/components/ui/confirm-dialog";

type ToolOption = { id: string; displayName: string };
const initialConfig: AssistantConfig = { name: "", description: "", instructions: "", model: null, tools: [], collections: [], usesMemory: true, retrieval: { semanticThreshold: 0.35, maxSources: 8, contextChars: 8000 } };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(getApiErrorMessage(payload, t("ui.assistants.templateOperationFailed")));
  return payload as T;
}

export default function AssistantsPage() {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();
  const [templates, setTemplates] = useState<AssistantTemplate[]>([]);
  const [models, setModels] = useState<ModelLibraryItem[]>([]);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [editing, setEditing] = useState<AssistantTemplate | null>(null);
  const [config, setConfig] = useState(initialConfig);
  const [collections, setCollections] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutation = useRef(false);
  const editorTrigger = useRef<HTMLElement | null>(null);

  async function load(signal?: AbortSignal) {
    const [assistants, preferences, catalog] = await Promise.all([
      chatApi.listAssistants(signal), request<{ data: { library: ModelLibraryItem[] } }>("/api/models", { signal }),
      request<{ data: ToolOption[] }>("/api/tools?mode=chat", { signal }),
    ]);
    if (signal?.aborted) return;
    setTemplates(assistants.data);
    setModels(preferences.data.library.filter(item => item.modes.includes("chat")));
    setTools(catalog.data);
  }
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function run(operation: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError("");
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : t("ui.assistants.templateOperationFailed")); }
    finally { mutation.current = false; setBusy(false); }
  }
  function select(template: AssistantTemplate | null, copy = false) {
    setEditing(copy ? null : template);
    setConfig(template ? { ...template.config, name: copy ? tf("ui.assistants.copy", { v0: template.config.name.slice(0, 54) }) : template.config.name } : initialConfig);
    setCollections(template?.config.collections.join("\n") ?? "");
    setError(""); setEditorOpen(true);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const parsed = assistantConfigSchema.safeParse({ ...config, collections: collections.split("\n").map(item => item.trim()).filter(Boolean) });
      if (!parsed.success) throw new Error(parsed.error.issues.map(item => `${item.path.join(".")}: ${item.message}`).join("；"));
      await request(editing ? `/api/assistants/${encodeURIComponent(editing.id)}` : "/api/assistants", {
        method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { revision: editing.revision, config: parsed.data } : parsed.data),
      });
      toast(t("ui.assistants.templateSavedExistingConversationsRetainTheir"));
      try { await load(); } catch { setError(t("ui.assistants.templateSavedButRefreshingTheList")); }
      setEditorOpen(false);
    });
  }

  // Deleted defaults can be put back; the ones still present keep their edits.
  const missingDefaults = DEFAULT_ASSISTANTS.filter(preset => !templates.some(template => template.id === preset.id)).length;
  const restoreDefaults = () => void run(async () => {
    const result = await request<{ data: AssistantTemplate[]; restored: string[] }>("/api/assistants/defaults", { method: "POST" });
    setTemplates(result.data);
    toast(tf("ui.assistants.defaultsRestored", { count: result.restored.length }));
  });

  return <main className="page-container mx-auto flex w-full max-w-5xl flex-col gap-5">
    <PageHeader title={t("ui.assistants.assistantTemplates")} description={t("ui.assistants.saveInstructionsToolsAndKnowledgeScopes")} actions={<Button id="new-template" size="sm" disabled={busy || loading} onClick={event => { editorTrigger.current = event.currentTarget; select(null); }}><Plus data-icon="inline-start" />{t("ui.assistants.newTemplate")}</Button>} />
    <Reveal className="-mt-5">{error && !editorOpen ? <p role="alert" className="mt-5 flex flex-wrap items-center gap-2 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)} <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => load())}>{t("conversations.refreshList")}</Button></p> : null}</Reveal>
    {loading ? <div role="status" aria-label={t("ui.assistants.loadingTemplates")} className="flex flex-col gap-2">{[0, 1, 2].map(key => <Skeleton key={key} className="h-20 rounded-xl" />)}</div> : null}
    {[true, false].map(builtin => {
      const group = templates.filter(template => template.builtin === builtin);
      const restorable = builtin && !loading && missingDefaults > 0;
      if (!group.length && !restorable) return null;
      return <section key={String(builtin)} aria-label={builtin ? t("ui.assistants.builtInTemplate") : t("ui.assistants.myTemplate")} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{builtin ? t("ui.assistants.builtInTemplate") : t("ui.assistants.myTemplate")}<span className="ml-2 text-muted-foreground">{group.length}</span></h2>
          {restorable ? <Button size="sm" variant="ghost" disabled={busy} onClick={restoreDefaults}><RotateCcw data-icon="inline-start" />{t("ui.assistants.restoreDefaults")}</Button> : null}</div>
        {!group.length ? <p className="text-sm text-muted-foreground">{t("ui.assistants.allDefaultsDeleted")}</p> : null}
        <div className="item-list" style={{ "--cols": "minmax(0, 1fr) auto 2rem", "--cols-narrow": "minmax(0, 1fr) auto 2rem" } as React.CSSProperties}>{group.map(template => { const name = template.builtin ? localizeMessage(template.config.name) : template.config.name; return <article key={template.id} {...removalKey(template.id)} data-testid={`assistant-template-${template.id}`} className="item-row data-row">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="truncate text-sm font-medium" title={name}>{name}</h3>
            <p className="line-clamp-1 text-sm text-muted-foreground">{(template.builtin ? localizeMessage(template.config.description) : template.config.description) || t("ui.assistants.customWorkflow")}</p>
            <p className="truncate text-xs text-muted-foreground">{template.config.tools.length} {t("ui.assistants.tools")}{template.config.usesMemory ? t("ui.assistants.memoryEnabled") : t("ui.assistants.memoryDisabled")} · {template.config.collections.length ? tf("ui.assistants.knowledgeCollections", { v0: template.config.collections.length }) : t("ui.assistants.allKnowledgeCollections")}{!template.builtin ? ` · v${template.revision}` : ""}</p>
          </div>
          <Button size="sm" variant="ghost" aria-label={t("ui.assistants.newConversationFromTemplate")} disabled={busy || loading} onClick={() => void run(async () => { const created = await chatApi.createConversation(template.config.name, template.id); window.localStorage.setItem(LAST_ACTIVE_CHAT_STORAGE_KEY, created.data.id); router.push("/chat"); })}><MessageSquarePlus data-icon="inline-start" />{t("ui.assistants.newConversation")}</Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={tf("ui.assistants.moreActionsFor", { v0: template.config.name })} disabled={busy} onPointerDown={event => { editorTrigger.current = event.currentTarget; }} onKeyDown={event => { editorTrigger.current = event.currentTarget; }}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (editorOpen) event.preventDefault(); }}>
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => select(template)}><Pencil aria-hidden="true" />{t("knowledge.edit")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => select(template, true)}><CopyPlus aria-hidden="true" />{t("ui.assistants.createCopy")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void run(async () => {
                  const outcome = await writeToClipboard(template.config.instructions);
                  if (outcome !== "copied") throw new Error(outcome === "refused" ? t("ui.assistants.cannotWriteToTheClipboardAllow") : t("ui.assistants.clipboardIsUnavailableOpenCreateCopy"));
                  toast(tf("ui.assistants.copiedInstructionsFor", { v0: template.config.name }));
                })}><Copy aria-hidden="true" />{t("ui.assistants.copyAssistantInstructions")}</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={async () => { if (await confirm({ title: t("ui.confirm.deleteAssistant"), description: tf("ui.assistants.deleteExistingConversationsWillRetainTheir", { v0: template.config.name }), action: t("ui.confirm.delete"), destructive: true })) void run(async () => { await request(`/api/assistants/${encodeURIComponent(template.id)}?confirm=true&revision=${template.revision}`, { method: "DELETE" }); await animateRemoval(template.id, load); toast(t("ui.assistants.templateDeletedExistingConversationSnapshotsWere")); }); }}><Trash2 aria-hidden="true" />{t("documents.delete")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </article>; })}</div>
      </section>;
    })}
    <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
      <SheetContent side="right" className="template-editor-sheet flex flex-col gap-5 p-5 sm:p-6" onCloseAutoFocus={event => { event.preventDefault(); const target = editorTrigger.current; (target?.isConnected ? target : document.getElementById("new-template"))?.focus(); }}>
        <header className="flex flex-col gap-2 pr-8"><SheetTitle className="break-words text-lg font-semibold">{editing ? tf("ui.assistants.edit", { v0: editing.config.name }) : t("ui.assistants.newCustomTemplate")}</SheetTitle><SheetDescription className="text-sm text-muted-foreground">{t("ui.assistants.savedIndependentlyWhenAppliedToA")}</SheetDescription></header>
        <Reveal className="-mt-5">{error ? <p role="alert" className="mt-5 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p> : null}</Reveal>
        <TemplateEditor config={config} setConfig={setConfig} collections={collections} setCollections={setCollections} models={models} tools={tools} disabled={busy || loading} busy={busy} onSubmit={save} />
      </SheetContent>
    </Sheet>
  </main>;
}
