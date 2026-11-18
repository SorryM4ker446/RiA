"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, Database, FolderArchive, FolderInput, FolderOpen, FolderSearch, House, Layers, Link2, MoreHorizontal, Trash2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Reveal } from "@/components/ui/reveal";
import { Spinner } from "@/components/ui/spinner";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { useSettingsContext } from "@/features/settings/settings-context";
import { formatDateTime, t, tf, type MessageKey } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

/*
 * Where the data and the cache live, and moving them.
 *
 * The page only reads and asks; the desktop shell checks a chosen folder,
 * records the move and restarts, and the move itself runs at the next start
 * before anything opens the data, with its own progress window. So the dialog
 * here says exactly what will happen before it happens, and the result is told
 * once the application is back.
 */

type Bridge = NonNullable<NonNullable<Window["riaDesktop"]>["dataLocation"]>;
const bridge = (): Bridge | null => (typeof window === "undefined" ? null : window.riaDesktop?.dataLocation ?? null);

/** Sizes as people read them on Windows: 1024-based, one decimal from a megabyte up. */
export function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Why the shell refused, as one sentence; codes it does not know read as a general refusal. */
export function refusalText(refusal: { code: string; details?: Record<string, unknown> }) {
  const key = `dataLocation.error.${refusal.code}` as MessageKey;
  const known = (t(key) as string | undefined) !== undefined;
  if (refusal.code === "insufficient-space") {
    const required = Number(refusal.details?.requiredBytes), available = Number(refusal.details?.availableBytes);
    if (Number.isFinite(required) && Number.isFinite(available)) return tf("dataLocation.error.insufficient-space", { required: formatSize(required), available: formatSize(available) });
    // A saved result keeps only the code, not the sizes.
    return t("dataLocation.error.insufficient-space-plain");
  }
  return known ? t(key) : t("dataLocation.error.unknown");
}

type Draft = {
  kind: DesktopLocationKind;
  target: string | null;
  /** What the person asked for, which names the dialog: a new folder, back home, or a kept copy. */
  intent: "move" | "home" | "use";
  from: string;
  /** Conversations answering now, which the restart would cut short; null until read. */
  answering: number | null;
  /** null while the shell is still checking the folder. */
  check: DesktopLocationCheck | null;
  submitting: boolean;
};

export function DataLocationSettings() {
  useLocale();
  const toast = useToast();
  const confirm = useConfirm();
  const [view, setView] = useState<DesktopDataLocationView | null>(null);
  const [sizes, setSizes] = useState<DesktopDataLocationSizes | null>(null);
  const [problem, setProblem] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busyCopy, setBusyCopy] = useState<string | null>(null);
  const checking = useRef(0);

  const show = useCallback((next: DesktopDataLocationView | null) => {
    if (!next) { setProblem(t("dataLocation.error.unknown")); return; }
    setView(next);
    // Walking a large data folder takes a moment; the rows show without it first.
    void bridge()?.sizes().then(setSizes).catch(() => {});
  }, []);
  const read = () => bridge()?.view().catch(() => null) ?? Promise.resolve(null);
  const refresh = () => read().then(show);
  useEffect(() => {
    let live = true;
    void read().then(next => { if (live) show(next); });
    return () => { live = false; };
  }, [show]);
  useRefreshOnReturn(() => refresh());

  const api = bridge();
  if (!api) return null;

  async function open(kind: DesktopLocationKind, target: string | null, intent: Draft["intent"] = "move") {
    if (!view) return;
    const ticket = ++checking.current;
    const from = kind === "data" ? view.data.path : view.cache.path;
    setDraft({ kind, target, intent, from, answering: null, check: null, submitting: false });
    const [check, answering] = await Promise.all([
      api!.check(kind, target).catch((): DesktopLocationCheck => ({ ok: false, code: "unknown" })),
      fetch("/api/conversations/live", { cache: "no-store" }).then(response => response.ok ? response.json() : null).then(body => Number(body?.data?.answering) || 0, () => 0),
    ]);
    // A folder chosen again while the first was being checked wins.
    if (ticket === checking.current) setDraft(current => current && { ...current, check, answering, target: check.ok ? check.target : target });
  }
  async function choose(kind: DesktopLocationKind) {
    const folder = await api!.choose(kind).catch(() => null);
    if (folder) await open(kind, folder);
  }
  async function submit() {
    if (!draft?.check?.ok) return;
    setDraft({ ...draft, submitting: true });
    const result = await api!.move(draft.kind, draft.target).catch((): DesktopLocationRefusal => ({ ok: false, code: "unknown" }));
    // On success the application is already restarting; the dialog stays as it is until it goes.
    if (!result.ok) setDraft(current => current && { ...current, submitting: false, check: result });
  }
  async function deleteCopy(copy: DesktopDataLocationView["copies"][number]) {
    const bytes = sizes?.copies[copy.path];
    const accepted = await confirm({
      title: t("dataLocation.deleteTitle"),
      description: tf("dataLocation.deleteBody", { path: copy.path, size: bytes == null ? t("dataLocation.dialog.unknown") : formatSize(bytes) }),
      action: t("dataLocation.deleteAction"), destructive: true,
    });
    if (!accepted) return;
    setBusyCopy(copy.path); setProblem("");
    const result = await api!.deleteCopy(copy.path).catch((): DesktopLocationRefusal => ({ ok: false, code: "unknown" }));
    setBusyCopy(null);
    if (!result.ok) { setProblem(refusalText(result)); return; }
    toast(bytes == null ? t("dataLocation.deleted") : { title: t("dataLocation.deleted"), description: tf("dataLocation.deletedDetail", { size: formatSize(bytes) }) });
    await refresh();
  }
  async function forgetCopy(path: string) {
    const result = await api!.forgetCopy(path).catch((): DesktopLocationRefusal => ({ ok: false, code: "unknown" }));
    if (!result.ok) { setProblem(refusalText(result)); return; }
    toast(t("dataLocation.forgotten"));
    await refresh();
  }
  async function dismissResult(id: string) {
    await api!.acknowledge(id).catch(() => {});
    await refresh();
  }

  const result = view?.result;
  const failure = result && !result.seen && result.outcome !== "moved" ? result : null;
  const lowSpace = sizes?.freeBytes != null && sizes.freeBytes < 5 * 1024 ** 3;

  return <section aria-label={t("dataLocation.title")} className="flex flex-col gap-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-sm font-medium">{t("dataLocation.title")}</h2>
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t("dataLocation.description")}</p>
      </div>
      <Button size="sm" disabled={!view || view.pending} onClick={() => void choose("data")}><FolderSearch data-icon="inline-start" />{t("dataLocation.change")}</Button>
    </div>

    <Reveal className="-mt-3">{failure ? <Alert className="mt-3" variant={failure.outcome === "cancelled" ? "default" : "destructive"}>
      <AlertDescription className="flex items-start justify-between gap-3">
        <span><span className="font-medium">{resultTitle(failure)}</span> {resultDetail(failure)}</span>
        <Button size="icon-sm" variant="ghost" className="-my-1 shrink-0" aria-label={t("dataLocation.result.dismiss")} onClick={() => void dismissResult(failure.id)}><X aria-hidden="true" /></Button>
      </AlertDescription>
    </Alert> : null}</Reveal>
    <Reveal className="-mt-3">{view?.cache.unavailable ? <Alert className="mt-3"><AlertDescription>{tf("dataLocation.cacheUnavailableNote", { path: view.cache.unavailable })}</AlertDescription></Alert> : null}</Reveal>
    <Reveal className="-mt-3">{problem ? <p role="alert" className="mt-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{problem}</p> : null}</Reveal>

    <div className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 5.5rem 2rem", "--cols-narrow": "minmax(0, 1fr) 5.5rem 2rem" } as React.CSSProperties}>
      <LocationRow
        icon={Database} name={t("dataLocation.data")} path={view?.data.path ?? ""}
        status={<Status tone={lowSpace ? "warning" : "success"}>{t("dataLocation.inUse")}</Status>}
        meta={view ? `${view.data.moved ? t("dataLocation.movedLocation") : t("dataLocation.defaultLocation")}${sizes?.freeBytes != null ? ` · ${tf(lowSpace ? "dataLocation.lowOnDrive" : "dataLocation.freeOnDrive", { size: formatSize(sizes.freeBytes) })}` : ""}` : ""}
        size={sizes ? sizes.dataBytes : undefined}
        menu={<>
          <DropdownMenuItem onSelect={() => view && void api.open(view.data.path)}><FolderOpen aria-hidden="true" />{t("dataLocation.open")}</DropdownMenuItem>
          {view?.data.moved ? <DropdownMenuItem disabled={view.pending} onSelect={() => void open("data", view.defaultPath, "home")}><House aria-hidden="true" />{t("dataLocation.moveHome")}</DropdownMenuItem> : null}
        </>}
      />
      <LocationRow
        icon={Layers} name={t("dataLocation.cache")} path={view?.cache.path ?? ""}
        status={view?.cache.unavailable ? <Status tone="warning">{t("dataLocation.cacheUnavailable")}</Status>
          : <Status>{view?.cache.custom ? t("dataLocation.cacheCustom") : t("dataLocation.cacheFollows")}</Status>}
        meta={t("dataLocation.cacheWhat")}
        size={sizes ? sizes.cacheBytes : undefined}
        menu={<>
          <DropdownMenuItem disabled={view?.pending} onSelect={() => void choose("cache")}><FolderSearch aria-hidden="true" />{t("dataLocation.changeCache")}</DropdownMenuItem>
          {view?.cache.custom || view?.cache.unavailable ? <DropdownMenuItem disabled={view.pending} onSelect={() => void open("cache", null)}><Link2 aria-hidden="true" />{t("dataLocation.followData")}</DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => view && void api.open(view.cache.path)}><FolderOpen aria-hidden="true" />{t("dataLocation.open")}</DropdownMenuItem>
        </>}
      />
    </div>
    {view?.pending ? <p className="text-xs text-muted-foreground">{t("dataLocation.pending")}</p> : null}

    {view?.copies.length ? <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t("dataLocation.copiesTitle")}<span className="ml-2 text-muted-foreground">{view.copies.length}</span></h3>
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t("dataLocation.copiesDescription")}</p>
      </div>
      <div className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 5.5rem 2rem", "--cols-narrow": "minmax(0, 1fr) 5.5rem 2rem" } as React.CSSProperties}>
        {view.copies.map(copy => <LocationRow
          key={copy.path} icon={FolderArchive} name={t("dataLocation.copy")} path={copy.path}
          status={copy.exists ? null : <Status tone="warning">{t("dataLocation.copyMissing")}</Status>}
          meta={tf(copy.reason === "left" ? "dataLocation.copyLeftAt" : copy.reason === "interrupted" ? "dataLocation.copyInterruptedAt" : "dataLocation.copyMovedAt", { date: formatDateTime(copy.at, { dateStyle: "medium", timeStyle: "short" }) })}
          size={!copy.exists ? null : sizes ? sizes.copies[copy.path] ?? null : undefined}
          busy={busyCopy === copy.path}
          menu={copy.exists ? <>
            <DropdownMenuItem disabled={view.pending} onSelect={() => void open("data", copy.path, "use")}><FolderInput aria-hidden="true" />{t("dataLocation.useCopy")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void api.open(copy.path)}><FolderOpen aria-hidden="true" />{t("dataLocation.open")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void deleteCopy(copy)}><Trash2 aria-hidden="true" />{t("dataLocation.deleteCopy")}</DropdownMenuItem>
          </> : <DropdownMenuItem onSelect={() => void forgetCopy(copy.path)}><X aria-hidden="true" />{t("dataLocation.forgetCopy")}</DropdownMenuItem>}
        />)}
      </div>
    </div> : null}

    <p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t("dataLocation.hint")}</p>
    <MoveDialog draft={draft} onClose={() => { checking.current++; setDraft(null); }} onChooseAnother={kind => void choose(kind)} onSubmit={() => void submit()} />
  </section>;
}

function LocationRow({ icon: Icon, name, path, status, meta, size, menu, busy = false }: {
  icon: typeof Database; name: string; path: string; status: React.ReactNode; meta: string;
  /** undefined while it is still being measured, null when it cannot be. */
  size: number | null | undefined; menu: React.ReactNode; busy?: boolean;
}) {
  return <article aria-label={`${name} ${path}`} className="item-row data-row">
    <span className="item-row-icon"><Icon aria-hidden="true" /></span>
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="shrink-0">{name}</span>{status}</p>
      <p className="truncate font-mono text-xs text-foreground/80" title={path}>{path}</p>
      <p className="truncate text-xs text-muted-foreground">{meta}</p>
    </div>
    <span className="col-meta col-end">{busy ? <Spinner className="ml-auto size-3.5" aria-hidden="true" /> : size === undefined ? <span className="text-muted-foreground/70">{t("dataLocation.calculating")}</span> : size === null ? "—" : formatSize(size)}</span>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" className="item-row-action" aria-label={tf("ui.assistants.moreActionsFor", { v0: name })} disabled={busy}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup>{menu}</DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
  </article>;
}

function MoveDialog({ draft, onClose, onChooseAnother, onSubmit }: { draft: Draft | null; onClose: () => void; onChooseAnother: (kind: DesktopLocationKind) => void; onSubmit: () => void }) {
  useLocale();
  // The dialog keeps its last content while it closes, so it does not empty before it fades.
  const [shown, setShown] = useState(draft);
  if (draft && draft !== shown) setShown(draft);
  const current = draft ?? shown;
  if (!current) return null;
  const { kind, intent, check, submitting } = current;
  const title = kind === "data" ? t(intent === "home" ? "dataLocation.dialog.titleHome" : intent === "use" ? "dataLocation.dialog.titleUse" : "dataLocation.dialog.titleData") : t(current.target === null ? "dataLocation.dialog.titleCacheFollow" : "dataLocation.dialog.titleCache");
  const to = current.target ?? t("dataLocation.dialog.dataFolder");
  const adopt = check?.ok && check.mode === "adopt";
  return <Dialog open={draft !== null} onOpenChange={next => { if (!next && !submitting) onClose(); }}>
    <DialogContent className="w-[min(32rem,92vw)]" onEscapeKeyDown={event => { if (submitting) event.preventDefault(); }}>
      <DialogHeader title={title} description={t(kind === "cache" ? "dataLocation.dialog.descriptionCache" : intent === "use" ? "dataLocation.dialog.descriptionUse" : "dataLocation.dialog.descriptionData")} />
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3 text-xs shadow-hairline">
          <p className="flex min-w-0 gap-2"><span className="w-6 shrink-0 text-muted-foreground">{t("dataLocation.dialog.from")}</span><span className="min-w-0 break-all font-mono">{current.from}</span></p>
          <ArrowDown aria-hidden="true" className="ml-8 size-3.5 text-muted-foreground" />
          <p className="flex min-w-0 gap-2"><span className="w-6 shrink-0 text-muted-foreground">{t("dataLocation.dialog.to")}</span><span className="min-w-0 break-all font-mono">{to}</span></p>
        </div>
        {check === null ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" aria-hidden="true" />{t("dataLocation.dialog.checking")}</p>
          : check.ok ? <>
            {adopt ? <Alert><AlertDescription>{t("dataLocation.dialog.adopt")}</AlertDescription></Alert> : <dl className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">{t("dataLocation.dialog.copySize")}</dt><dd className="tabular-nums">{formatSize(check.copyBytes)}</dd></div>
              <div className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">{t("dataLocation.dialog.available")}</dt><dd className="tabular-nums">{check.availableBytes === null ? t("dataLocation.dialog.unknown") : formatSize(check.availableBytes)}</dd></div>
            </dl>}
            {current.answering ? <Alert><AlertDescription>{tf("dataLocation.dialog.answering", { count: current.answering })}</AlertDescription></Alert> : null}
            <p className="text-xs leading-5 text-muted-foreground">{t(adopt ? "dataLocation.dialog.restartAdopt" : kind === "cache" ? "dataLocation.dialog.restartCache" : "dataLocation.dialog.restart")}</p>
          </> : <Alert variant="destructive"><AlertDescription>{refusalText(check)}</AlertDescription></Alert>}
      </DialogBody>
      <DialogFooter>
        {intent === "move" && current.target !== null ? <Button className="mr-auto" variant="ghost" disabled={submitting} onClick={() => onChooseAnother(kind)}>{t("dataLocation.dialog.chooseAnother")}</Button> : null}
        <Button variant="outline" disabled={submitting} onClick={onClose}>{t("dataLocation.dialog.cancel")}</Button>
        {check === null || check.ok ? <Button disabled={!check?.ok || submitting} onClick={onSubmit}>{submitting ? <><Spinner data-icon="inline-start" />{t("dataLocation.dialog.restarting")}</> : t(adopt ? "dataLocation.dialog.confirmAdopt" : "dataLocation.dialog.confirm")}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function resultTitle(result: DesktopMoveResult) {
  switch (result.outcome) {
    case "moved": return t(result.kind === "data" ? "dataLocation.result.movedTitle" : "dataLocation.result.cacheMovedTitle");
    case "cancelled": return t("dataLocation.result.cancelledTitle");
    case "interrupted": return t("dataLocation.result.interruptedTitle");
    default: return t(result.kind === "data" ? "dataLocation.result.failedTitle" : "dataLocation.result.failedCacheTitle");
  }
}
function resultDetail(result: DesktopMoveResult) {
  switch (result.outcome) {
    case "moved": return t(result.kind === "data" ? "dataLocation.result.movedDetail" : "dataLocation.result.cacheMovedDetail");
    case "cancelled": return t(result.kind === "data" ? "dataLocation.result.cancelledDetail" : "dataLocation.result.cancelledCacheDetail");
    case "interrupted": return t("dataLocation.result.interruptedDetail");
    default: return tf(result.kind === "data" ? "dataLocation.result.failedDetail" : "dataLocation.result.failedCacheDetail", { reason: refusalText({ code: result.code ?? "unknown", details: {} }) });
  }
}

/**
 * Tells the person, once the application is back, how a move went, and once
 * that the data's drive is running out of room. Mounted with the app, not the
 * settings page, because the restart lands on the chat.
 */
export function DataLocationNotices() {
  useLocale();
  const toast = useToast();
  const { open } = useSettingsContext();
  const done = useRef(false);
  useEffect(() => {
    const api = bridge();
    if (!api || done.current) return;
    done.current = true;
    void api.view().then(view => {
      const result = view.result;
      if (result && !result.seen) {
        const lasting = result.outcome === "failed" || result.outcome === "interrupted";
        toast({
          title: resultTitle(result), description: resultDetail(result),
          ...(lasting ? { action: { label: t("dataLocation.lowSpace.action"), run: () => open("storage") } } : {}),
        });
        // A failure stays on the storage page until it is dismissed there; the rest is said once.
        if (!lasting) void api.acknowledge(result.id);
        return;
      }
      if (view.lowSpace) {
        toast({ tone: "warning", title: t("dataLocation.lowSpace.title"), description: tf("dataLocation.lowSpace.detail", { size: formatSize(view.lowSpace.freeBytes) }), action: { label: t("dataLocation.lowSpace.action"), run: () => open("storage") } });
        void api.dismissLowSpace();
      }
    }).catch(() => {});
  }, [toast, open]);
  return null;
}
