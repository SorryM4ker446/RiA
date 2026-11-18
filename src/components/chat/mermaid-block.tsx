"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { Code2, Network } from "lucide-react";

/* The page's theme, followed as it changes, so a diagram is drawn in matching colours. */
function watchTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains("dark");

type Drawn = { svg: string; error: null } | { svg: null; error: string } | null;

/**
 * A Mermaid diagram in an answer. Mermaid loads on first use and draws in its
 * strict mode (its output is sanitised, scripts and links in labels are not
 * allowed). The source is one click away; a diagram that does not parse shows
 * its source with Mermaid's message instead of an empty box.
 */
/** The page's own colours, as Mermaid reads them: flat boxes on the code-block surface, no shadows, labels on the same ground. */
function diagramColours() {
  const style = getComputedStyle(document.documentElement);
  const colour = (name: string, alpha?: number) => {
    const [h, sat, light] = style.getPropertyValue(name).trim().split(/\s+/);
    return alpha === undefined ? `hsl(${h}, ${sat}, ${light})` : `hsla(${h}, ${sat}, ${light}, ${alpha})`;
  };
  return {
    darkMode: document.documentElement.classList.contains("dark"),
    background: colour("--muted"), mainBkg: colour("--card"), primaryColor: colour("--card"), secondaryColor: colour("--muted"), tertiaryColor: colour("--muted"),
    primaryTextColor: colour("--foreground"), secondaryTextColor: colour("--foreground"), tertiaryTextColor: colour("--foreground"), textColor: colour("--foreground"),
    primaryBorderColor: colour("--foreground", .28), secondaryBorderColor: colour("--foreground", .2), tertiaryBorderColor: colour("--foreground", .2),
    lineColor: colour("--muted-foreground"), edgeLabelBackground: colour("--muted"), clusterBkg: colour("--muted"), clusterBorder: colour("--foreground", .14),
    noteBkgColor: colour("--muted"), noteTextColor: colour("--foreground"), noteBorderColor: colour("--foreground", .2), fontSize: "13px",
  };
}

export function MermaidBlock({ code }: { code: string }) {
  useLocale();
  const dark = useSyncExternalStore(watchTheme, isDark, () => false);
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn>(null);
  const [source, setSource] = useState(false);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: diagramColours(), fontFamily: "inherit" });
        await mermaid.parse(code);
        const { svg } = await mermaid.render(`${id}-${dark ? "d" : "l"}`, code);
        if (current) setDrawn({ svg, error: null });
      } catch (error) {
        if (current) setDrawn({ svg: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { current = false; };
  }, [code, dark, id]);

  const showSource = source || drawn?.error;
  return <figure className="mermaid-block" data-state={drawn === null ? "drawing" : drawn.error ? "failed" : "drawn"}>
    <figcaption className="code-block-head">
      <span className="code-block-lang">mermaid</span>
      {drawn?.svg ? <button type="button" className="code-block-action" onClick={() => setSource(!source)} aria-pressed={source}>
        {source ? <Network aria-hidden="true" /> : <Code2 aria-hidden="true" />}{source ? t("chat.mermaid.showDiagram") : t("chat.mermaid.showSource")}
      </button> : null}
    </figcaption>
    {drawn?.error ? <p role="status" className="mermaid-error">{t("chat.mermaid.failed")}<span>{drawn.error.split("\n")[0]}</span></p> : null}
    {showSource ? <pre><code>{code}</code></pre>
      : drawn?.svg ? <div className="mermaid-diagram" role="img" aria-label={t("chat.mermaid.diagram")} dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      : <p className="mermaid-loading">{t("chat.mermaid.drawing")}</p>}
  </figure>;
}
