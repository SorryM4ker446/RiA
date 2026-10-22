"use client";
import { useLocale } from "@/lib/locale/client";

import { AlertCircle, Check, Copy } from "lucide-react";
import { memo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils/cn";
import { t } from "@/lib/locale";
import { writeToClipboard } from "@/lib/clipboard";
import { splitMarkdownBlocks } from "./markdown-blocks";

type MarkdownMessageProps = {
  text: string;
  allowImages?: boolean;
};

const markdownComponents: Components = {
  a: ({ children, href, ...props }) => (
    <a href={href} rel="noreferrer" target="_blank" {...props}>
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
  /*
   * A code block is the part of an answer that gets reused verbatim, so it
   * carries its own copy control rather than making the reader select text
   * inside a scrollable box.
   */
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

function readCodeText(children: React.ReactNode): string {
  const collect = (node: React.ReactNode): string => {
    if (typeof node === "string") return node;
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(collect).join("");
    if (node && typeof node === "object" && "props" in node) {
      return collect((node as { props?: { children?: React.ReactNode } }).props?.children);
    }
    return "";
  };
  return collect(children);
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  useLocale();
  const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
  const code = readCodeText(children);
  async function copy() {
    const outcome = await writeToClipboard(code);
    // A refusal is shown rather than swallowed: the reader pressed a control
    // and nothing happened, and telling them so is the only thing that makes
    // the difference between a broken control and a missed click.
    setState(outcome === "copied" ? "copied" : outcome === "refused" ? "refused" : "idle");
    // The label has to fall back on its own: the button can be unmounted by
    // the next thing the reader does.
    if (outcome === "copied") setTimeout(() => setState((current) => (current === "copied" ? "idle" : current)), 2000);
  }
  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      <button
        aria-label={state === "refused" ? t("chat.copyCodeRefused") : t("chat.copyCode")}
        aria-live="polite"
        className={cn(
          "absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md border bg-background/90 transition-opacity",
          state === "refused" ? "border-destructive text-destructive" : "border-border text-muted-foreground",
          "opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100",
        )}
        onClick={copy}
        title={state === "refused" ? t("chat.copyCodeRefused") : undefined}
        type="button"
      >
        {state === "copied" ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />
        ) : state === "refused" ? (
          <AlertCircle aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

const rehypePlugins = [rehypeSanitize];
const remarkPlugins = [remarkGfm];
const imageElements = ["img"];

const MarkdownBlock = memo(function MarkdownBlock({ text, allowImages }: Required<MarkdownMessageProps>) {
  return (
    <ReactMarkdown components={markdownComponents} rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins} disallowedElements={allowImages ? undefined : imageElements}>
      {text}
    </ReactMarkdown>
  );
});

/*
 * Parsing is the expensive part of a message, and a streamed reply re-renders
 * the whole transcript on every update. Unchanged text keeps its parsed tree:
 * other messages are skipped entirely, and within the growing reply only the
 * block still being written is parsed again.
 */
export const MarkdownMessage = memo(function MarkdownMessage({ text, allowImages = true }: MarkdownMessageProps) {
  useLocale();
  return (
    <div className="markdown-message">
      {splitMarkdownBlocks(text).map((block, index) => <MarkdownBlock key={index} text={block} allowImages={allowImages} />)}
    </div>
  );
});
