"use client";

import { useMemo } from "react";

/** Keep the complete script selectable without laying out every offscreen line. */
export function CommandText({ command = "" }: { command?: string }) {
  const blocks = useMemo(() => {
    if (command.length < 32_768) return [];
    const result: Array<{ text: string; lines: number }> = [];
    let start = 0;
    while (start < command.length) {
      let end = start;
      let lines = 0;
      while (end < command.length && lines < 128) {
        const newline = command.indexOf("\n", end);
        end = newline < 0 ? command.length : newline + 1;
        lines++;
      }
      result.push({ text: command.slice(start, end), lines });
      start = end;
    }
    return result;
  }, [command]);

  return blocks.length > 1 ? blocks.map((block, index) => <span key={index} style={{
    display: "block", contentVisibility: "auto", containIntrinsicBlockSize: `auto ${block.lines}lh`,
  }}>{block.text}</span>) : command;
}
