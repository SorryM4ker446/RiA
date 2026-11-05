"use client";
import { useMemo, useState } from "react";
import { Check, ChevronRight, Search } from "lucide-react";
import { useLocale } from "@/lib/locale/client";
import { localizeMessage, t, tf } from "@/lib/locale";
import { toolLabel } from "@/features/chat/use-tools";
import type { ToolCatalogItem } from "@/features/chat/types";

const CATEGORY_KEYS = { knowledge: "ui.assistants.tools.knowledge", web: "ui.assistants.tools.web", workspace: "ui.assistants.tools.workspace", tasks: "ui.assistants.tools.tasks" } as const;
/** A list this long is easier to search than to scan. */
const SEARCH_FROM = 12;
/** A connection with more tools than this starts folded, so it stays one line until wanted. */
const FOLD_FROM = 8;

type Row = { id: string; label: string; description: string };
type Group = { key: string; label: string; rows: Row[] };

/**
 * A template's tools as names to switch on, gathered by what they let it do. Every
 * name is visible at once and takes little room, so the list stays readable as
 * connections are added. What a tool does appears on the line below while it is
 * pointed at, in place of repeating a description under every name. Tools only the
 * model uses are not offered: they come along with what they serve.
 */
export function TemplateTools({ tools, value, onChange }: { tools: ToolCatalogItem[]; value: string[]; onChange: (next: string[]) => void }) {
  useLocale();
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<string[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    const add = (key: string, label: string, row: Row) => { const group = byKey.get(key) ?? { key, label, rows: [] }; group.rows.push(row); byKey.set(key, group); };
    for (const key of Object.keys(CATEGORY_KEYS)) byKey.set(key, { key, label: t(CATEGORY_KEYS[key as keyof typeof CATEGORY_KEYS]), rows: [] });
    for (const tool of tools) {
      if (tool.surface.template !== "selectable") continue;
      if (tool.extensionId) add(`extension:${tool.extensionId}`, tool.extensionName ?? tool.displayName, { id: tool.id, label: toolLabel(tool), description: tool.description });
      else add(tool.surface.category, "", { id: tool.id, label: localizeMessage(tool.displayName), description: localizeMessage(tool.description) });
    }
    // Chosen once and since removed: still listed, so the choice can be undone.
    for (const id of value) if (!tools.some(tool => tool.id === id)) add("removed", t("ui.assistants.tools.removed"), { id, label: tf("ui.assistants.template-editor.removedTool", { v0: id.slice(-8) }), description: "" });
    return [...byKey.values()].filter(group => group.rows.length);
  }, [tools, value]);
  const wanted = query.trim().toLowerCase();
  const shown = wanted ? groups.flatMap(group => {
    const rows = group.label.toLowerCase().includes(wanted) ? group.rows : group.rows.filter(row => `${row.label} ${row.description}`.toLowerCase().includes(wanted));
    return rows.length ? [{ ...group, rows }] : [];
  }) : groups;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const selected = groups.reduce((sum, group) => sum + group.rows.filter(row => value.includes(row.id)).length, 0);
  const setRows = (rows: Row[], checked: boolean) => {
    const ids = rows.map(row => row.id);
    onChange(checked ? [...new Set([...value, ...ids])] : value.filter(id => !ids.includes(id)));
  };
  const hint = hovered ? groups.flatMap(group => group.rows).find(row => row.id === hovered)?.description : "";
  return <div className="template-tools" onMouseLeave={() => setHovered(null)}>
    <div className="template-tools-head">
      <span className="template-tools-title">{t("ui.assistants.template-editor.availableTools")}</span>
      <span className="template-tools-count">{tf("ui.assistants.tools.count", { selected, total })}</span>
      {total > 0 ? <button type="button" className="template-tools-action ml-auto" onClick={() => setRows(groups.flatMap(group => group.rows), selected < total)}>{selected < total ? t("ui.assistants.tools.selectAll") : t("ui.assistants.tools.clear")}</button> : null}
    </div>
    {total >= SEARCH_FROM ? <label className="template-tools-search">
      <Search aria-hidden="true" className="size-3.5 shrink-0" />
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("ui.assistants.tools.search")} aria-label={t("ui.assistants.tools.search")} />
    </label> : null}
    {shown.map(group => {
      const chosen = group.rows.filter(row => value.includes(row.id)).length;
      const foldable = group.rows.length >= FOLD_FROM;
      const flipped = toggled.includes(group.key);
      const open = !foldable || Boolean(wanted) || flipped;
      const allChosen = chosen === group.rows.length;
      return <section key={group.key} className="template-tools-group" aria-label={group.label}>
        <header className="template-tools-group-head">
          {foldable ? <button type="button" className="template-tools-fold" aria-expanded={open} onClick={() => setToggled(current => flipped ? current.filter(key => key !== group.key) : [...current, group.key])}><ChevronRight aria-hidden="true" data-open={open || undefined} />{group.label}</button> : <span>{group.label}</span>}
          {group.rows.length > 1 ? <>
            <span className="template-tools-group-count">{chosen}/{group.rows.length}</span>
            <button type="button" className="template-tools-action template-tools-group-action" onClick={() => setRows(group.rows, !allChosen)}>{allChosen ? t("ui.assistants.tools.clear") : t("ui.assistants.tools.selectAll")}</button>
          </> : null}
        </header>
        <div className="reveal" data-state={open ? "open" : "closed"} aria-hidden={!open || undefined}>
          <div className="min-h-0 overflow-hidden">
            <div className="template-tools-names">
              {group.rows.map(row => <label key={row.id} className="template-tool" onMouseEnter={() => setHovered(row.id)} onFocus={() => setHovered(row.id)} onBlur={() => setHovered(null)}>
                <input type="checkbox" tabIndex={open ? undefined : -1} checked={value.includes(row.id)} onChange={event => setRows([row], event.target.checked)} />
                <Check aria-hidden="true" className="template-tool-check" />
                <span>{row.label}</span>
              </label>)}
            </div>
          </div>
        </div>
      </section>;
    })}
    {!shown.length ? <p className="template-tools-hint">{t("ui.assistants.tools.noMatch")}</p> : null}
    {/* Always a line tall, so pointing at a tool moves nothing. */}
    <p className="template-tools-hint" title={hint || undefined}>{hint || t("ui.assistants.template-editor.onlySelectedToolsAreAllowedApprovals")}</p>
  </div>;
}
