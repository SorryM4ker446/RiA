"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf } from "@/lib/locale";

import { CircleArrowUp } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { updatePending, updatePercent, useUpdate } from "@/features/updates/update-provider";

/**
 * The sidebar's line about a new version, above the settings entry.
 *
 * It appears only while an update has been found and not yet installed. While
 * one is offered, a click starts it; once it is under way, a click shows its
 * progress again, so a dialog hidden with Escape is never out of reach.
 */
export function UpdateNotice({ onNavigate }: { onNavigate?: () => void }) {
  useLocale();
  const { state, start, show } = useUpdate();
  const pending = updatePending(state) ? state : null;
  const underway = pending && pending.phase !== "available";

  if (!pending) return <Reveal className="-mb-1" />;
  const version = pending.availableVersion ?? "";
  const percent = updatePercent(pending);
  const status = pending.phase === "available" ? t("update.notice.actionLabel")
    : pending.phase === "downloading" ? tf("update.notice.downloading", { percent })
    : t("update.notice.installing");

  return (
    // Closed, it gives back the footer's gap, so the settings row does not move.
    <Reveal className="-mb-1">
      {/* A row like the navigation above it, with the one thing to do at its end. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${tf("update.notice.title", { version })} · ${status}`}
        className="workspace-nav-link mb-1 w-full bg-accent/60 text-left"
        onClick={() => { onNavigate?.(); if (underway) show(); else start(); }}
      >
        <CircleArrowUp aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{tf("update.notice.title", { version })}</span>
        <span
          aria-hidden="true"
          className={pending.phase === "available"
            ? "shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium leading-4 text-primary-foreground"
            : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums text-muted-foreground"}
        >
          {pending.phase === "available" ? t("update.notice.action") : pending.phase === "downloading" ? `${percent}%` : t("update.notice.installingShort")}
        </span>
        {pending.phase === "downloading" ? (
          <span aria-hidden="true" className="absolute inset-x-3 bottom-1 h-0.5 overflow-hidden rounded-full bg-foreground/10">
            <span className="block h-full rounded-full bg-foreground/70 transition-[width] duration-[--dur-base] ease-[--ease-out]" style={{ width: `${percent}%` }} />
          </span>
        ) : null}
      </button>
    </Reveal>
  );
}
