"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { t } from "@/lib/locale";

/**
 * The "back to chat" affordance every sub-page carries.
 *
 * It was previously bare muted text, which read as static copy rather than
 * something clickable. The icon, the hover surface and the focus ring give it
 * the same affordance as any other control, and one component keeps the five
 * pages that use it identical.
 */
export function BackToChatLink({ className }: { className?: string }) {
  return (
    <Link
      className={
        "inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors duration-[--dur-fast] ease-[--ease-out] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] " +
        (className ?? "")
      }
      href="/chat"
    >
      <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
      {t("nav.backToChat")}
    </Link>
  );
}
