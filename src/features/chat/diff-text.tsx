"use client";

import { useMemo } from "react";

/** A unified diff with added and removed lines marked by color and by their +/- prefix. */
export function DiffText({ diff = "" }: { diff?: string }) {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  return lines.map((line, index) => {
    const kind = line.startsWith("+++") || line.startsWith("---") ? "file"
      : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
    return <span key={index} data-diff-line={kind} className={kind === "added" ? "block bg-success/10 text-success"
      : kind === "removed" ? "block bg-destructive/10 text-destructive"
        : kind === "hunk" || kind === "file" ? "block text-muted-foreground" : "block"}>{line || " "}</span>;
  });
}
