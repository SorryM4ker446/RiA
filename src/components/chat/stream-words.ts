import type { Element, ElementContent, Root } from "hast";

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
/** Code is shown as it is written; it arrives with its block rather than word by word. */
const KEPT_WHOLE = new Set(["pre", "code"]);

const word = (value: string, block: number): Element => ({ type: "element", tagName: "span", properties: { className: ["stream-word"], dataBlock: block }, children: [{ type: "text", value }] });

/**
 * Splits running text into words, each in a `.stream-word` span, so words can fade in one by one as an answer is
 * written. Punctuation stays with the word before it, and spaces stay plain text, so lines break and space exactly
 * as they do without the spans. Spans already on screen keep their identity as text is appended (React keys
 * elements by position among their siblings), so only what is new animates.
 */
export function splitWords(value: string, block = 0): ElementContent[] {
  if (!segmenter) return [{ type: "text", value }];
  const parts: ElementContent[] = [];
  let current: Element | null = null;
  for (const { segment, isWordLike } of segmenter.segment(value)) {
    if (/^\s+$/.test(segment)) {
      parts.push({ type: "text", value: segment });
      current = null;
    } else if (isWordLike || !current) {
      current = word(segment, block);
      parts.push(current);
    } else {
      (current.children[0] as { value: string }).value += segment;
    }
  }
  return parts;
}

function split(node: Root | Element, block: number) {
  if (node.type === "element" && KEPT_WHOLE.has(node.tagName)) return;
  const children: (Root | Element)["children"] = [];
  for (const child of node.children) {
    if (child.type === "text") children.push(...splitWords(child.value, block));
    else {
      if (child.type === "element") split(child, block);
      children.push(child as ElementContent);
    }
  }
  node.children = children as typeof node.children;
}

/**
 * A rehype plugin applying `splitWords` to a whole rendered block, marking each word with the block it belongs to.
 * It runs after sanitizing, which would drop the class and the mark.
 */
export function rehypeStreamWords({ block = 0 }: { block?: number } = {}) {
  return (tree: Root) => { split(tree, block); };
}
