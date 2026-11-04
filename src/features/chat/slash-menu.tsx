"use client";
import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Book, Box, Boxes, Brain, Check, FileOutput, FileText, Globe, ListChecks, Plug, Wrench } from "lucide-react";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";

export type SlashIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
export type SlashGroup = "recent" | "tools" | "skills" | "plugins" | "templates";
export type SlashItem = {
  key: string;
  group: SlashGroup;
  label: string;
  description: string;
  meta?: string;
  icon: SlashIcon;
  chosen?: boolean;
  /** Shown instead of acting: why this cannot be used now. */
  blocked?: string;
  /** Choosing a blocked row goes to where it can be set up. */
  opensSetup?: boolean;
  /** Text that finds the item but is not shown, such as its id. */
  terms?: string;
  run: () => void;
};

const TOOL_ICONS: Record<string, SlashIcon> = { webSearch: Globe, searchKnowledge: Book, saveMemory: Brain, createTask: ListChecks, readDocument: FileText, convertDocument: FileOutput };
export const toolIcon = (toolId: string, isExtension: boolean): SlashIcon => isExtension ? Plug : TOOL_ICONS[toolId] ?? Wrench;
export const SKILL_ICON: SlashIcon = Box;
export const TEMPLATE_ICON: SlashIcon = Boxes;

/**
 * The word being typed after a slash, when there is one. A slash opens the menu
 * only where a word could start, so a path or a date written in a sentence never does.
 */
export function slashQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  return match ? { query: match[1], start: before.length - match[1].length - 1 } : null;
}

/** Best matches first: the name's start, then anywhere in the name, then what it does. */
export function filterSlashItems(items: SlashItem[], query: string) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return items;
  const rank = (item: SlashItem) => {
    const label = item.label.toLowerCase();
    if (label.startsWith(wanted)) return 0;
    if (label.includes(wanted) || item.terms?.toLowerCase().includes(wanted)) return 1;
    return `${item.description} ${item.meta ?? ""}`.toLowerCase().includes(wanted) ? 2 : -1;
  };
  return items.map(item => ({ item, rank: rank(item) })).filter(entry => entry.rank >= 0).sort((a, b) => a.rank - b.rank).map(entry => entry.item);
}

function highlighted(text: string, query: string): ReactNode {
  const wanted = query.trim().toLowerCase();
  const at = wanted ? text.toLowerCase().indexOf(wanted) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark className="slash-item-match">{text.slice(at, at + wanted.length)}</mark>{text.slice(at + wanted.length)}</>;
}

const MAX_LIST_HEIGHT = 272;

export function SlashMenu({ open, items: liveItems, activeIndex, query: liveQuery, listId, anchor, onActivate, onSelect, onDismiss }: {
  open: boolean;
  items: SlashItem[];
  activeIndex: number;
  query: string;
  listId: string;
  anchor: ReactNode;
  onActivate: (index: number) => void;
  onSelect: (item: SlashItem) => void;
  onDismiss: () => void;
}) {
  // Closing clears the list, and the panel is still fading out then. It keeps what
  // it showed, or it would collapse to a bright sliver above the composer.
  const [shown, setShown] = useState({ items: liveItems, query: liveQuery });
  if (open && (shown.items !== liveItems || shown.query !== liveQuery)) setShown({ items: liveItems, query: liveQuery });
  const { items, query } = open ? { items: liveItems, query: liveQuery } : shown;
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  // Follows the content rather than jumping when a filter changes how much there is.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!open || !content) return;
    const measure = () => { if (listRef.current) listRef.current.style.height = `${Math.min(content.offsetHeight, MAX_LIST_HEIGHT)}px`; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open]);
  // One marker glides between rows, so moving through the list reads as one motion.
  useLayoutEffect(() => {
    const list = listRef.current, marker = markerRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-slash-index="${activeIndex}"]`);
    if (!list || !marker) return;
    marker.style.opacity = row ? "1" : "0";
    if (!row) return;
    marker.style.transform = `translateY(${row.offsetTop}px)`;
    marker.style.height = `${row.offsetHeight}px`;
    if (row.offsetTop < list.scrollTop) list.scrollTop = Math.max(0, row.offsetTop - 28);
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
  }, [activeIndex, items, open]);

  return <PopoverPrimitive.Root open={open} modal={false}>
    <PopoverPrimitive.Anchor asChild>{anchor}</PopoverPrimitive.Anchor>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        className="slash-menu"
        side="top" align="start" sideOffset={8} collisionPadding={8}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onEscapeKeyDown={event => event.preventDefault()}
        onInteractOutside={event => { if (!(event.target as Element | null)?.closest?.(".composer-input")) onDismiss(); else event.preventDefault(); }}
      >
        <div ref={listRef} id={listId} role="listbox" aria-label={t("chat.slash.label")} className="slash-menu-list">
          <div ref={contentRef} className="slash-menu-content">
            <div ref={markerRef} aria-hidden="true" className="slash-menu-marker" />
            {items.map((item, index) => {
              const heading = item.group !== items[index - 1]?.group ? t(`chat.slash.group.${item.group}`) : null;
              const Icon = item.icon;
              return <div key={`${item.group}:${item.key}`} role="presentation">
                {heading ? <div role="presentation" className="slash-menu-heading">{heading}</div> : null}
                <div
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={item.blocked ? true : undefined}
                  data-slash-index={index}
                  className={cn("slash-item", index === activeIndex && "slash-item-active")}
                  onMouseMove={() => { if (index !== activeIndex) onActivate(index); }}
                  // The caret stays in the message box the whole time the menu is open.
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => onSelect(item)}
                >
                  <Icon aria-hidden={true} className="slash-item-icon" />
                  <span className="slash-item-label">{highlighted(item.label, query)}</span>
                  <span className="slash-item-description">{item.blocked ?? item.description}</span>
                  {item.chosen ? <Check aria-label={t("chat.slash.chosen")} className="slash-item-check" /> : item.meta ? <span className="slash-item-meta">{item.meta}</span> : null}
                </div>
              </div>;
            })}
          </div>
        </div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}
