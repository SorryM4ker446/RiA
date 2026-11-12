"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatDateTime, localizeMessage } from "@/lib/locale";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Loader2, ShieldOff, Terminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { SettingsSection } from "@/features/settings/settings-section";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { SelectField, SelectOption } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { APPROVAL_RULES, readApprovalRule, type ApprovalRule } from "@/lib/approvals/rules";
import { cn } from "@/lib/utils/cn";

type GrantRow = {
  id: string;
  label: string;
  path: string;
  realPath: string;
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
  useLocale();
  const pathId = useId();
  const ruleId = useId();
  const toast = useToast();
  const loadRequest = useRef(0);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  // The rule a new conversation starts with; null until it has been read.
  const [defaultRule, setDefaultRule] = useState<ApprovalRule | null>(null);
  const busy = saving || choosing;

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const response = await fetch("/api/directory-grants", { cache: "no-store" });
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

  useEffect(() => {
    if (embedded) return;
    let active = true;
    void fetch("/api/approval-preferences", { cache: "no-store" }).then(response => response.ok ? response.json() : null)
      .then(payload => { if (active && payload) setDefaultRule(readApprovalRule(payload.data?.defaultRule)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [embedded]);

  /** Conversations started from now on begin with this rule; existing ones keep theirs. */
  async function changeDefaultRule(value: string) {
    const rule = readApprovalRule(value);
    const previous = defaultRule;
    setDefaultRule(rule);
    try {
      const response = await fetch("/api/approval-preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ defaultRule: rule }) });
      if (!response.ok) throw new Error(await readError(response));
      toast(tf("approval.defaultSaved", { rule: t(`approval.rule.${rule}`) }));
    } catch (cause) {
      setDefaultRule(previous);
      setError(cause instanceof Error ? cause.message : t("approval.saveFailed"));
    }
  }

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
      // The withdrawn folder folds away before the list reloads without it.
      await animateRemoval(id, load);
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
    const bridge = window.riaDesktop;
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
            <AlertDescription>{localizeMessage(error)}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("settings.grants.loading")}
          </p>
        ) : (
          <div>
          {grants.length ? <ul className="settings-list" aria-label={t("ui.settings.directory-grants.directoryAccess")}>
            {grants.map((grant) => (
              <li className="directory-grant-row flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center" key={grant.id} {...removalKey(grant.id)}>
                <div className="w-full min-w-0 sm:w-auto">
                  <p className="truncate text-sm font-medium">{grant.label}</p>
                  <p className="truncate text-xs text-muted-foreground" title={grant.realPath}>{grant.path}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {grant.lastUsedAt
                      ? `${t("settings.grants.lastUsed")}${formatDateTime(new Date(grant.lastUsedAt))}`
                      : t("settings.grants.neverUsed")}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button disabled={busy} onClick={() => void revoke(grant.id)} size="sm" type="button" variant="ghost">
                    <ShieldOff aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t("settings.grants.revoke")}
                  </Button>
                </div>
              </li>
            ))}
          </ul> : null}
          {/* After the last folder folds away the note eases in, rather than appearing at full height. */}
          <Reveal>{grants.length ? null : <p className="text-xs text-muted-foreground">{t("settings.grants.empty")}</p>}</Reveal>
          </div>
        )}

        <form className={cn("flex gap-2", embedded ? "flex-col" : "flex-wrap items-end sm:flex-nowrap")} onSubmit={add}>
          <Field className="min-w-0 flex-1 gap-2">
          <FieldLabel htmlFor={pathId} className={embedded ? undefined : "sr-only"}>{t("ui.settings.directory-grants.directoryPath")}</FieldLabel>
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
          <Button disabled={busy || (typeof window !== "undefined" && !window.riaDesktop?.chooseFolder)} onClick={() => void choose()} type="button" variant="ghost">
            <FolderOpen aria-hidden="true" className="mr-1.5 h-4 w-4" />
            {embedded ? t("ui.settings.directory-grants.chooseDirectory") : t("settings.grants.browse")}
          </Button>
          <Button disabled={busy || !path.trim()} type="submit">
            {saving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("settings.grants.add")}
          </Button>
          </div>
        </form>
        <p className="text-[11px] text-muted-foreground">{t("settings.grants.note")} {t("approval.grantNote")}</p>
        {/* Adding a folder is what lets commands run in it, so this is said where the folder is added. */}
        {typeof window !== "undefined" && window.riaDesktop ? <Alert role="note">
          <AlertTitle>{t("ui.settings.directory-grants.commandsRunAsTheCurrentWindows")}</AlertTitle>
          <AlertDescription>{t("ui.settings.directory-grants.theWorkingDirectoryIsNotA")}</AlertDescription>
        </Alert> : null}
        {!embedded ? (
          <Field className="gap-2">
            <FieldLabel htmlFor={ruleId}>{t("approval.defaultTitle")}</FieldLabel>
            <SelectField id={ruleId} className="w-full sm:w-72" value={defaultRule ?? ""} disabled={defaultRule === null} onValueChange={value => void changeDefaultRule(value)}>
              {APPROVAL_RULES.map(rule => <SelectOption key={rule} value={rule}>{t(`approval.rule.${rule}`)} · {t(`approval.ruleHint.${rule}`)}</SelectOption>)}
            </SelectField>
            <FieldDescription>{t("approval.defaultHint")}</FieldDescription>
          </Field>
        ) : null}
      </div>
  );
  return <>
      {embedded ? content : <SettingsSection title={<><FolderOpen aria-hidden="true" className="size-4 text-muted-foreground" />{t("settings.grants.title")}</>} description={t("ui.settings.directory-grants.authorizeOnlyTheDirectoriesYouNeed")}>
        <div className="flex flex-col gap-4">{content}</div>
      </SettingsSection>}
  </>;
}
