"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf } from "@/lib/locale";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderLock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { DirectoryGrantSettings } from "@/features/settings/directory-grants";

type WorkspaceGrant = { id: string; label: string; realPath: string; terminalEnabled: boolean };

/** The authorized folders, or null when they could not be read; the server checks every choice anyway. */
async function fetchGrants(): Promise<WorkspaceGrant[] | null> {
  try {
    const response = await fetch("/api/directory-grants", { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    return Array.isArray(payload.data) ? payload.data : [];
  } catch { return null; }
}

/**
 * The conversation's workspace and the permissions it is chosen from.
 *
 * Authorizing a folder (工作区权限) is a standing, machine-wide permission;
 * choosing one here says which single authorized folder this conversation works
 * in. The choice can change between turns but not while a reply is generating,
 * and the server restates it to the model on every request.
 */
export function DirectoryPermissions({ workspaceGrantId, locked, saving, onSelect, onChange }: {
  workspaceGrantId: string | null;
  locked: boolean;
  saving: boolean;
  onSelect: (grantId: string | null) => Promise<boolean>;
  onChange: () => void;
}) {
  useLocale();
  const toast = useToast();
  const [grants, setGrants] = useState<WorkspaceGrant[]>([]);
  const loadRequest = useRef(0);
  // Only the latest read is shown; a failed one keeps the folders already listed.
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    const list = await fetchGrants();
    if (list && request === loadRequest.current) setGrants(list);
  }, []);
  useEffect(() => {
    const requests = loadRequest;
    const request = ++requests.current;
    void fetchGrants().then(list => { if (list && request === requests.current) setGrants(list); });
    return () => { ++requests.current; };
  }, []);

  const selected = grants.find(grant => grant.id === workspaceGrantId) ?? null;
  const name = selected?.label ?? (workspaceGrantId ? t("ui.chat.workspace.label") : t("ui.chat.workspace.choose"));

  async function choose(value: string) {
    const next = value || null;
    if (next === workspaceGrantId || locked || saving) return;
    if (!await onSelect(next)) return;
    const grant = grants.find(item => item.id === next);
    toast(grant ? tf("ui.chat.workspace.switched", { v0: grant.label }) : t("ui.chat.workspace.cleared"));
  }

  return <>
    <DropdownMenu onOpenChange={open => { if (open) void load(); }}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="chat-workspace-picker max-w-[7.5rem] sm:max-w-[14rem]" disabled={locked || saving}
          aria-label={tf("ui.chat.workspace.current", { v0: name })} title={locked ? t("ui.chat.workspace.lockedWhileGenerating") : selected?.realPath ?? t("ui.chat.workspace.choose")}>
          <Folder aria-hidden="true" data-icon="inline-start" />
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown aria-hidden="true" className="opacity-60 max-sm:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t("ui.chat.workspace.menuTitle")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selected?.id ?? ""} onValueChange={value => void choose(value)}>
          {grants.map(grant => (
            <DropdownMenuRadioItem key={grant.id} value={grant.id} title={grant.realPath}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{grant.label}</span>
                <span className="truncate text-xs text-muted-foreground">{grant.terminalEnabled ? grant.realPath : `${t("ui.chat.workspace.terminalOff")} · ${grant.realPath}`}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
          {grants.length ? <DropdownMenuSeparator /> : <p className="px-2.5 py-2 text-xs text-muted-foreground">{t("ui.chat.workspace.empty")}</p>}
          <DropdownMenuRadioItem value="">{t("ui.chat.workspace.none")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={t("ui.settings.filePermissions")} title={t("ui.chat.directory-permissions.manageFileAccessAndTerminalPermissions")}>
          {/* On a phone the toolbar keeps one row: the label folds away and the button keeps its name. */}
          <FolderLock aria-hidden="true" data-icon="inline-start" /><span className="max-sm:sr-only">{t("ui.settings.filePermissions")}</span></Button>
      </SheetTrigger>
      <SheetContent side="right" className="directory-permissions-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel={t("ui.chat.directory-permissions.closeFilePermissions")}>
        <header className="flex flex-col gap-2 pr-7">
          <SheetTitle>{t("ui.settings.filePermissions")}</SheetTitle>
          <SheetDescription>{t("ui.chat.directory-permissions.manageLocalDirectoriesAvailableToAll")}</SheetDescription>
        </header>
        <div className="chat-list-scroll min-h-0 flex-1 overflow-y-auto">
          <DirectoryGrantSettings embedded onChange={() => { void load(); onChange(); }} />
        </div>
      </SheetContent>
    </Sheet>
  </>;
}
