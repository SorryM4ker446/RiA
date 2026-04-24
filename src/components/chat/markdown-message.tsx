"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

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
};

export function MarkdownMessage({ text }: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
