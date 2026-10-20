"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Loader2, ShieldOff, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/features/settings/settings-section";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/locale";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TerminalApprovalMode } from "@/lib/terminal/schema";
import { cn } from "@/lib/utils/cn";

type GrantRow = {
  id: string;
  label: string;
  path: string;
  realPath: string;
  terminalEnabled: boolean;
  terminalApprovalMode: TerminalApprovalMode;
  updatedAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return typeof payload?.error?.message === "string" ? payload.error.message : t("settings.grants.failed");
  } catch {
    return t("settings.grants.failed");
  }
}

/**
 * What the user opened to the assistant, and how to take it back.
 *
 * Granting is deliberately a separate, explicit act with nothing else on the
 * page that can cause it, because a grant is a standing permission: the
 * assistant can read and create files there on any later turn without asking
 * again. Withdrawing is one click and takes effect on the next tool call, not
 * on the next restart.
 */
export function DirectoryGrantSettings({ embedded = false, onChange }: { embedded?: boolean; onChange?: () => void }) {
  const pathId = useId();
  const modeId = useId();
  const loadRequest = useRef(0);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalGrant, setTerminalGrant] = useState<GrantRow | null>(null);
  const [terminalMode, setTerminalMode] = useState<TerminalApprovalMode>("approval");
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const busy = saving || permissionSaving || choosing;

  async function changeTerminal(grant: GrantRow, enabled: boolean, mode: TerminalApprovalMode = "approval") {
    setPermissionSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/directory-grants/${encodeURIComponent(grant.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalEnabled: enabled, terminalApprovalMode: mode, revision: grant.updatedAt }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setTerminalGrant(null);
      onChange?.();
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.grants.failed")); }
    finally { setPermissionSaving(false); }
  }

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      // Withdrawing a grant keeps the record, so it is asked for explicitly:
      // without this the user sees a folder disappear and no way to find out
      // what was taken away or when.
      const response = await fetch("/api/directory-grants?includeRevoked=true", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await response.json();
      if (request !== loadRequest.current) return;
      setGrants(Array.isArray(payload.data) ? payload.data : []);
      setError(null);
    } catch (loadError) {
      if (request !== loadRequest.current) return;
      setError(loadError instanceof Error ? loadError.message : t("settings.grants.failed"));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const requests = loadRequest;
    void load();
    return () => { ++requests.current; };
  }, [load]);

  async function add(event: { preventDefault: () => void; stopPropagation: () => void }) {
    event.preventDefault();
    // Directory authorization must not trigger an enclosing form's action.
    event.stopPropagation();
    const chosen = path.trim();
    if (!chosen || busy) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/directory-grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: chosen })
      });
      if (!response.ok) throw new Error(await readError(response));
      setPath("");
      onChange?.();
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : t("settings.grants.failed"));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    if (busy) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/directory-grants/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      onChange?.();
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : t("settings.grants.failed"));
    } finally { setSaving(false); }
  }

  /**
   * Ask the operating system which folder, rather than expecting it to be
   * typed. A typed path can be mistyped, pasted from somewhere, or arrived at
   * through an influence the user never noticed; the dialog only ever returns
   * something the user pointed at. The path still has to be granted afterwards
   * — choosing one is not granting it.
   */
  async function choose() {
    const bridge = window.privateAiDesktop;
    if (!bridge?.chooseFolder || busy) return;
    setChoosing(true);
    try {
      const chosen = await bridge.chooseFolder();
      if (!chosen.canceled && chosen.path) setPath(chosen.path);
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : t("settings.grants.failed"));
    } finally { setChoosing(false); }
  }

  const content = (
      <div className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("settings.grants.failedTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("settings.grants.loading")}
          </p>
        ) : grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.grants.empty")}</p>
        ) : (
          <ul className="settings-list" aria-label="目录授权">
            {grants.map((grant) => (
              <li className="flex flex-col items-start justify-between gap-3 sm:flex-row" key={grant.id}>
                <div className="w-full min-w-0 sm:w-auto">
                  <p className="truncate text-sm font-medium">{grant.label}</p>
                  <p className="truncate text-xs text-muted-foreground" title={grant.realPath}>{grant.path}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {grant.revokedAt
                      ? `${t("settings.grants.revoked")}${new Date(grant.revokedAt).toLocaleString()}`
                      : grant.lastUsedAt
                        ? `${t("settings.grants.lastUsed")}${new Date(grant.lastUsedAt).toLocaleString()}`
                        : t("settings.grants.neverUsed")}
                  </p>
                </div>
                {/* A withdrawn folder is shown rather than offered: there is nothing left to withdraw. */}
                {grant.revokedAt ? null : (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {typeof window !== "undefined" && window.privateAiDesktop ? <>
                  <Button disabled={busy} onClick={() => { setTerminalMode(grant.terminalApprovalMode); setTerminalGrant(grant); }} size="sm" type="button" variant="outline">
                    <Terminal aria-hidden="true" data-icon="inline-start" />
                    {grant.terminalEnabled ? `终端：${grant.terminalApprovalMode === "full-access" ? "完全访问" : "审批"}` : "开启终端"}
                  </Button>
                  {grant.terminalEnabled ? <Button disabled={busy} onClick={() => void changeTerminal(grant, false)} size="sm" type="button" variant="outline">关闭终端</Button> : null}
                  </> : null}
                  <Button disabled={busy} onClick={() => void revoke(grant.id)} size="sm" type="button" variant="outline">
                    <ShieldOff aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t("settings.grants.revoke")}
                  </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form className={cn("flex gap-2", embedded ? "flex-col" : "flex-wrap items-end sm:flex-nowrap")} onSubmit={add}>
          <Field className="min-w-0 flex-1 gap-2">
          <FieldLabel htmlFor={pathId} className={embedded ? undefined : "sr-only"}>目录路径</FieldLabel>
          <Input
            id={pathId}
            className="min-w-0"
            disabled={busy}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t("settings.grants.placeholder")}
            value={path}
          />
          </Field>
          <div className="flex items-center justify-end gap-2">
          <Button disabled={busy || (typeof window !== "undefined" && !window.privateAiDesktop?.chooseFolder)} onClick={() => void choose()} type="button" variant="outline">
            <FolderOpen aria-hidden="true" className="mr-1.5 h-4 w-4" />
            {embedded ? "选择目录" : t("settings.grants.browse")}
          </Button>
          <Button disabled={busy || !path.trim()} type="submit">
            {saving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("settings.grants.add")}
          </Button>
          </div>
        </form>
        <p className="text-[11px] text-muted-foreground">{t("settings.grants.note")}</p>
      </div>
  );
  return <>
      {embedded ? content : <SettingsSection title={<><FolderOpen aria-hidden="true" className="size-4 text-muted-foreground" />{t("settings.grants.title")}</>} description="只授权你需要的目录。终端权限单独开启，可选择完全访问或逐条审批。">
        <div className="flex flex-col gap-4">{content}</div>
      </SettingsSection>}
      <Sheet open={!!terminalGrant} onOpenChange={open => { if (!open && !permissionSaving) setTerminalGrant(null); }}>
        <SheetContent side="right" className="directory-permissions-sheet flex flex-col gap-5 overflow-y-auto p-6">
          <SheetTitle>{terminalGrant?.terminalEnabled ? "终端权限" : "开启终端权限"}</SheetTitle>
          <SheetDescription>允许 RiA 在此目录读取、搜索、新建、编辑、复制、移动和删除文件，并执行开发命令。选择命令的审批方式。</SheetDescription>
          <p className="break-all font-mono text-xs">{terminalGrant?.realPath}</p>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={modeId}>终端模式</FieldLabel>
              <Select value={terminalMode} disabled={permissionSaving} onValueChange={value => setTerminalMode(value as TerminalApprovalMode)}>
                <SelectTrigger id={modeId} aria-describedby={`${modeId}-description`}><SelectValue /></SelectTrigger>
                <SelectContent><SelectGroup>
                  <SelectItem value="approval">审批</SelectItem>
                  <SelectItem value="full-access">完全访问</SelectItem>
                </SelectGroup></SelectContent>
              </Select>
              <FieldDescription id={`${modeId}-description`}>{terminalMode === "full-access" ? "LLM 的终端操作自动执行，无需逐条批准。" : "LLM 每次调用终端工具都需要你批准，拒绝则不执行。"}</FieldDescription>
            </Field>
          </FieldGroup>
          <Alert>
            <Terminal aria-hidden="true" />
            <AlertTitle>命令以当前 Windows 用户身份运行</AlertTitle>
            <AlertDescription>工作目录不是文件访问沙箱。命令可能修改目录外的文件、访问网络或启动程序；原有文件工具的路径限制不适用于终端。切换模式或关闭权限会停止此目录正在运行的命令。</AlertDescription>
          </Alert>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <div className="mt-auto flex justify-end gap-2">
            <Button disabled={permissionSaving} variant="outline" onClick={() => setTerminalGrant(null)}>取消</Button>
            <Button disabled={permissionSaving || !terminalGrant} onClick={() => terminalGrant && void changeTerminal(terminalGrant, true, terminalMode)}>
              {permissionSaving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Terminal data-icon="inline-start" />}
              {terminalGrant?.terminalEnabled ? "保存终端权限" : "确认开启终端权限"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
  </>;
}
