"use client";

import { useEffect, useRef } from "react";

/**
 * Reads a page's data again whenever the window comes back into view, so a
 * list that may have changed in the background (a scheduled review, an
 * indexing run, a generation finishing) is current without a refresh button
 * and without polling. The read is the page's own silent refresh: rows stay on
 * screen while it runs.
 */
export function useRefreshOnReturn(refresh: () => unknown, enabled = true) {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; });
  useEffect(() => {
    if (!enabled) return;
    // Focus and visibility often change together; one read at a time covers both.
    let reading = false;
    const onReturn = () => {
      if (document.visibilityState !== "visible" || reading) return;
      reading = true;
      void Promise.resolve(latest.current()).finally(() => { reading = false; });
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => { window.removeEventListener("focus", onReturn); document.removeEventListener("visibilitychange", onReturn); };
  }, [enabled]);
}
