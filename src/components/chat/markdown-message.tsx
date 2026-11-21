"use client";
import { useLocale } from "@/lib/locale/client";

import { AlertCircle, Check, Copy } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
type PluggableList = NonNullable<Options["rehypePlugins"]>;
import { cn } from "@/lib/utils/cn";
import { t } from "@/lib/locale";
import { writeToClipboard } from "@/lib/clipboard";
import { splitMarkdownBlocks } from "./markdown-blocks";
import { rehypeStreamWords } from "./stream-words";
import { hasMath, highlighter, mathPlugins, prepareMath, useLazy } from "./rich-content";
import { MermaidBlock } from "./mermaid-block";

type MarkdownMessageProps = {
  text: string;
  allowImages?: boolean;
};

type Highlighter = NonNullable<ReturnType<typeof highlighter.get>>;

const baseComponents: Components = {
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

/**
 * A block's components: code blocks get the highlighter once it has loaded,
 * and know whether the block is still being written, in which case a diagram
 * is not drawn yet (a half-written one would fail). Code is highlighted as it
 * is written, so the streamed answer looks as it will when finished.
 */
function blockComponents(writing: boolean, hljs: Highlighter | null): Components {
  return {
    ...baseComponents,
    /*
     * A code block is the part of an answer that gets reused verbatim, so it
     * carries its own copy control rather than making the reader select text
     * inside a scrollable box.
     */
    pre: ({ children }) => <CodeBlock writing={writing} hljs={hljs}>{children}</CodeBlock>,
  };
}

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

/** The fence's language, from the code element's language-… class. */
function readLanguage(children: React.ReactNode): string | null {
  const code = (Array.isArray(children) ? children[0] : children) as { props?: { className?: unknown } } | null;
  const className = code && typeof code === "object" ? code.props?.className : undefined;
  const names = Array.isArray(className) ? className : typeof className === "string" ? className.split(/\s+/) : [];
  const language = names.map(String).find(name => name.startsWith("language-"))?.slice("language-".length);
  return language && language !== "math" ? language.toLowerCase() : null;
}

function CodeBlock({ children, writing, hljs }: { children: React.ReactNode; writing: boolean; hljs: Highlighter | null }) {
  useLocale();
  const [state, setState] = useState<"idle" | "copied" | "refused">("idle");
  const code = readCodeText(children).replace(/\n$/, "");
  const language = readLanguage(children);
  // Highlighted in a language the highlighter knows, partial code included; its output escapes the code.
  const highlighted = useMemo(() => {
    if (!hljs || !language || !hljs.getLanguage(language)) return null;
    try { return hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { return null; }
  }, [hljs, language, code]);
  if (language === "mermaid" && !writing) return <MermaidBlock code={code} />;
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
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{language ?? t("chat.code.plain")}</span>
        <button
          aria-label={state === "refused" ? t("chat.copyCodeRefused") : t("chat.copyCode")}
          aria-live="polite"
          className={cn("code-block-action", state === "refused" && "text-destructive")}
          onClick={copy}
          title={state === "refused" ? t("chat.copyCodeRefused") : undefined}
          type="button"
        >
          {state === "copied" ? <Check aria-hidden="true" className="text-success" /> : state === "refused" ? <AlertCircle aria-hidden="true" /> : <Copy aria-hidden="true" />}
          <span>{state === "copied" ? t("chat.code.copied") : t("chat.code.copy")}</span>
        </button>
      </div>
      {highlighted !== null
        ? <pre><code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
        : <pre>{children}</pre>}
    </div>
  );
}

/* The default schema, letting the math parser's classes through for the formula renderer that runs after it. */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./, "math-inline", "math-display"]] },
};
const sanitize: PluggableList[number] = [rehypeSanitize, sanitizeSchema];
const imageElements = ["img"];

/**
 * One top-level block. While it is the one being written, its words fade in one by one (see stream-words); it keeps
 * their spans until its own last fade has finished, then renders as plain text again, exactly as when loaded. So
 * only text written in the last moment carries spans, and nothing snaps when a block or the answer is finished.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text, allowImages, index, writing, container }: Required<MarkdownMessageProps> & { index: number; writing: boolean; container: RefObject<HTMLDivElement | null> }) {
  const [words, setWords] = useState(writing);
  if (writing && !words) setWords(true);
  useEffect(() => {
    if (writing || !words) return;
    const fading = (container.current?.getAnimations({ subtree: true }) ?? []).filter(animation =>
      (animation as CSSAnimation).animationName === "stream-word-in" && ((animation.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.dataset.block === String(index));
    let current = true;
    void Promise.allSettled(fading.map(animation => animation.finished)).then(() => { if (current) setWords(false); });
    return () => { current = false; };
  }, [writing, words, index, container]);
  // Formulas wait until the block is written; until then they read as plain text.
  const math = useLazy(mathPlugins, !writing && hasMath(text));
  // Formulas wait until the block is written; code is highlighted as it comes. A fence may be indented, as in a list item.
  const hljs = useLazy(highlighter, /^[ \t]*(```|~~~)/m.test(text));
  // CJK-friendly emphasis: "**总体判断：**项目" is bold, as a reader expects, though CommonMark alone will not
  // close "**" after a full-width colon or stop when a letter follows. Only that case changes.
  const remarkPlugins = useMemo<PluggableList>(() => math ? [remarkGfm, remarkCjkFriendly, [math.remarkMath, { singleDollarTextMath: true }]] : [remarkGfm, remarkCjkFriendly], [math]);
  // The formula renderer runs after the sanitiser, so what it draws is not stripped; it escapes what it is given.
  const rehypePlugins = useMemo<PluggableList>(() => words ? [sanitize, [rehypeStreamWords, { block: index }]] : math ? [sanitize, math.rehypeKatex] : [sanitize], [words, index, math]);
  const components = useMemo(() => blockComponents(writing, hljs), [writing, hljs]);
  return (
    <ReactMarkdown components={components} rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins} disallowedElements={allowImages ? undefined : imageElements}>
      {math ? prepareMath(text) : text}
    </ReactMarkdown>
  );
});

/*
 * Parsing is the expensive part of a message, and a streamed reply re-renders
 * the whole transcript on every update. Unchanged text keeps its parsed tree:
 * other messages are skipped entirely, and within the growing reply only the
 * block still being written is parsed again.
 */
export const MarkdownMessage = memo(function MarkdownMessage({ text, allowImages = true, streaming = false }: MarkdownMessageProps & { streaming?: boolean }) {
  useLocale();
  const container = useRef<HTMLDivElement>(null);
  const blocks = splitMarkdownBlocks(text);
  return (
    <div ref={container} className="markdown-message" data-streaming={streaming || undefined}>
      {blocks.map((block, index) => <MarkdownBlock key={index} text={block} allowImages={allowImages} index={index} writing={streaming && index === blocks.length - 1} container={container} />)}
    </div>
  );
});
