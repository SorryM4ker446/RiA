"use client";
import { useRef } from "react";
import { ChevronRight } from "lucide-react";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import { useDisclosureMotion } from "./message-thinking";

/**
 * Where a conversation's earlier turns were folded into its summary. The turns
 * above stay readable; this says the model now sees them as the summary, and shows
 * what that summary says.
 */
export function CompactionMarker({ summary }: { summary: string }) {
  useLocale();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const move = useDisclosureMotion();
  return <details ref={disclosure} className="message-reasoning compaction-marker" data-compaction-marker>
    <summary className="message-reasoning-summary" onClick={event => { event.preventDefault(); const node = disclosure.current!; move(node, node.dataset.folding ? node.dataset.folding === "closing" : !node.open); }}>
      <ChevronRight aria-hidden="true" className="reasoning-chevron" />
      <span>{t("chat.compact.marker")}</span>
    </summary>
    <div className="message-reasoning-body"><p className="whitespace-pre-wrap">{summary}</p></div>
  </details>;
}
