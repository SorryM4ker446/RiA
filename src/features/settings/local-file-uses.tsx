"use client";

import { useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t, tf } from "@/lib/locale";

export type LocalFileUse = {
  /** The granted folder, as the assistant named it. */
  grantLabel: string;
  grantId: string;
  /** The name inside that folder, which is what the model worked with. */
  path: string;
  toolId: string;
};

/**
 * What a turn read or produced, and where it went.
 *
 * Shown rather than implied because a granted folder is the one place where
 * content leaves the machine in a way the user did not type into the message:
 * reading a file sends it to whichever provider answers the turn. The provider
 * is named for the same reason the folder is — the user can see what was used,
 * so a surprising disclosure is visible before the next turn rather than
 * discovered later.
 */
export function LocalFileUses({ uses, modelLabel }: { uses: LocalFileUse[]; modelLabel?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (uses.length === 0) return null;

  /**
   * Ask the service to turn the name into a real path, then hand that to the
   * shell. The service re-checks containment, so this cannot be used to point a
   * file manager at something outside a grant.
   */
  async function reveal(use: LocalFileUse) {
    setBusy(use.path);
    setError(null);
    try {
      const response = await fetch("/api/directory-grants/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantId: use.grantId, path: use.path })
      });
      if (!response.ok) throw new Error(t("localFiles.revealFailed"));
      const payload = await response.json();
      const bridge = window.privateAiDesktop;
      // Outside the desktop shell there is no file manager to point at, so the
      // button is not offered rather than quietly doing nothing.
      if (!bridge?.revealPath) return;
      await bridge.revealPath(payload.data.absolutePath);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : t("localFiles.revealFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
      <p className="font-medium text-foreground">{t("localFiles.usedTitle")}</p>
      <ul className="mt-1 space-y-1 text-muted-foreground">
        {uses.map((use) => (
          <li className="flex items-center justify-between gap-2" key={`${use.toolId}:${use.path}`}>
            <span className="min-w-0 truncate" title={`${use.grantLabel}/${use.path}`}>
              {use.grantLabel}/{use.path}
            </span>
            {typeof window !== "undefined" && window.privateAiDesktop?.revealPath ? (
              <Button disabled={busy === use.path} onClick={() => void reveal(use)} size="sm" type="button" variant="ghost">
                {busy === use.path
                  ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                  : <FolderOpen aria-hidden="true" className="h-3 w-3" />}
                {t("localFiles.reveal")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {modelLabel ? <p className="mt-1 text-muted-foreground">{tf("localFiles.sentTo", { model: modelLabel })}</p> : null}
      {error ? <p className="mt-1 text-destructive">{error}</p> : null}
    </div>
  );
}
