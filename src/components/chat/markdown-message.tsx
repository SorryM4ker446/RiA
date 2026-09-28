"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils/cn";
import { t } from "@/lib/locale";

type MarkdownMessageProps = {
  text: string;
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
  const [copied, setCopied] = useState(false);
  const code = readCodeText(children);
  async function copy() {
    if (!code.trim()) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      // The label has to fall back on its own: the button can be unmounted by
      // the next thing the reader does.
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A clipboard the page was not allowed to use is not worth interrupting
      // the answer for; the text stays selectable.
    }
  }
  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      <button
        aria-label={t("chat.copyCode")}
        className={cn(
          "absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md border border-border bg-background/90 text-muted-foreground transition-opacity",
          "opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100",
        )}
        onClick={copy}
        type="button"
      >
        {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function MarkdownMessage({ text }: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
