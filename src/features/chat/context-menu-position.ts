type Point = { x: number; y: number };

const textLayout = ["font", "font-kerning", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform",
  "direction", "padding", "line-height", "tab-size", "word-break", "overflow-wrap"];

function draftCaret(input: HTMLTextAreaElement): Point {
  const box = input.getBoundingClientRect();
  const style = getComputedStyle(input);
  const mirror = document.createElement("div");
  for (const property of textLayout) mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: "fixed", visibility: "hidden", pointerEvents: "none", left: "0", top: "0",
    boxSizing: "border-box", width: `${input.clientWidth}px`, whiteSpace: input.wrap === "off" ? "pre" : "pre-wrap",
  });
  const offset = input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
  const marker = document.createElement("span");
  // Keeping the rest of the word in the mirror gives it the same line wrap as
  // the textarea. A trailing newline still needs a box for the empty line.
  marker.textContent = input.value.slice(offset) || "\u200b";
  mirror.append(input.value.slice(0, offset), marker);
  document.body.append(mirror);
  try {
    const caret = marker.getClientRects()[0];
    return {
      x: box.left + input.clientLeft + (caret?.left ?? 0) - input.scrollLeft,
      y: box.top + input.clientTop + (caret?.bottom ?? 0) - input.scrollTop,
    };
  } finally { mirror.remove(); }
}

function selectionCaret(anchor: HTMLElement): Point | undefined {
  const selection = window.getSelection();
  const focus = selection?.focusNode;
  if (!focus || selection.isCollapsed || !anchor.contains(focus)) return;
  const edge = document.createRange();
  edge.setStart(focus, selection.focusOffset);
  const rect = edge.getClientRects()[0];
  if (rect?.height) return { x: rect.left, y: rect.bottom };
}

export function keyboardMenuPoint(anchor: HTMLElement): Point {
  const box = anchor.getBoundingClientRect();
  const scrollport = anchor.closest(".chat-transcript")?.getBoundingClientRect();
  const point = anchor instanceof HTMLTextAreaElement ? draftCaret(anchor)
    : selectionCaret(anchor) ?? { x: box.left + 8, y: box.top + Math.min(24, box.height) };
  // Long bodies, code on a horizontal scrollbar, and a textarea scrolled to a
  // different line can put the selection endpoint outside the visible surface.
  const left = Math.max(box.left, scrollport?.left ?? 0, 0);
  const right = Math.min(box.right, scrollport?.right ?? innerWidth, innerWidth);
  const top = Math.max(box.top, scrollport?.top ?? 0, 0);
  const bottom = Math.min(box.bottom, scrollport?.bottom ?? innerHeight, innerHeight);
  return { x: Math.max(left, Math.min(right - 1, point.x)), y: Math.max(top, Math.min(bottom - 1, point.y)) };
}
