"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Loader2, ShieldOff, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/locale";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

type GrantRow = {
  id: string;
  label: string;
  path: string;
  realPath: string;
  terminalEnabled: boolean;
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
export function DirectoryGrantSettings() {
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminalGrant, setTerminalGrant] = useState<GrantRow | null>(null);
  const [permissionSaving, setPermissionSaving] = useState(false);

  async function changeTerminal(grant: GrantRow, enabled: boolean) {
    setPermissionSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/directory-grants/${encodeURIComponent(grant.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminalEnabled: enabled, revision: grant.updatedAt }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setTerminalGrant(null);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("settings.grants.failed")); }
    finally { setPermissionSaving(false); }
  }

  const load = useCallback(async () => {
    try {
      // Withdrawing a grant keeps the record, so it is asked for explicitly:
      // without this the user sees a folder disappear and no way to find out
      // what was taken away or when.
      const response = await fetch("/api/directory-grants?includeRevoked=true", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await response.json();
      setGrants(Array.isArray(payload.data) ? payload.data : []);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("settings.grants.failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add(event: { preventDefault: () => void }) {
    event.preventDefault();
    const chosen = path.trim();
    if (!chosen || saving) return;
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
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : t("settings.grants.failed"));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const response = await fetch(`/api/directory-grants/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response));
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : t("settings.grants.failed"));
    }
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
    if (!bridge?.chooseFolder) return;
    try {
      const chosen = await bridge.chooseFolder();
      if (!chosen.canceled && chosen.path) setPath(chosen.path);
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : t("settings.grants.failed"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderOpen aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          {t("settings.grants.title")}
        </CardTitle>
        <CardDescription>{t("settings.grants.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
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
          <ul className="space-y-2">
            {grants.map((grant) => (
              <li className="flex flex-col items-start justify-between gap-3 rounded-md border border-border px-3 py-2 sm:flex-row" key={grant.id}>
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
                  {typeof window !== "undefined" && window.privateAiDesktop ? <Button disabled={permissionSaving} onClick={() => grant.terminalEnabled ? void changeTerminal(grant, false) : setTerminalGrant(grant)} size="sm" type="button" variant="outline">
                    <Terminal aria-hidden="true" data-icon="inline-start" />
                    {grant.terminalEnabled ? "关闭终端" : "开启终端"}
                  </Button> : null}
                  <Button disabled={permissionSaving} onClick={() => void revoke(grant.id)} size="sm" type="button" variant="outline">
                    <ShieldOff aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t("settings.grants.revoke")}
                  </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form className="flex items-center gap-2" onSubmit={add}>
          <Input
            onChange={(event) => setPath(event.target.value)}
            placeholder={t("settings.grants.placeholder")}
            value={path}
          />
          <Button disabled={saving} onClick={() => void choose()} type="button" variant="outline">
            <FolderOpen aria-hidden="true" className="mr-1.5 h-4 w-4" />
            {t("settings.grants.browse")}
          </Button>
          <Button disabled={saving || !path.trim()} type="submit">
            {saving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("settings.grants.add")}
          </Button>
        </form>
        <p className="text-[11px] text-muted-foreground">{t("settings.grants.note")}</p>
      </CardContent>
      <Sheet open={!!terminalGrant} onOpenChange={open => { if (!open && !permissionSaving) setTerminalGrant(null); }}>
        <SheetContent side="right" className="flex flex-col gap-5 p-6">
          <SheetTitle>开启终端权限</SheetTitle>
          <SheetDescription>允许 RiA 在此目录启动 PowerShell，每条命令仍需你确认。</SheetDescription>
          <p className="break-all font-mono text-xs">{terminalGrant?.realPath}</p>
          <Alert>
            <Terminal aria-hidden="true" />
            <AlertTitle>命令以当前 Windows 用户身份运行</AlertTitle>
            <AlertDescription>工作目录不是文件访问沙箱。命令可能修改目录外的文件、访问网络或启动程序；原有文件工具的路径限制不适用于终端。关闭权限会停止此目录正在运行的命令。</AlertDescription>
          </Alert>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <div className="mt-auto flex justify-end gap-2">
            <Button disabled={permissionSaving} variant="outline" onClick={() => setTerminalGrant(null)}>取消</Button>
            <Button disabled={permissionSaving || !terminalGrant} onClick={() => terminalGrant && void changeTerminal(terminalGrant, true)}>
              {permissionSaving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Terminal data-icon="inline-start" />}
              确认开启终端权限
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}
