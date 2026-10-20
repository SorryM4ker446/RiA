"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowUp, List, Loader2 } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { messageLocations, type MessageLocation } from "./message-locations";

function MessageMark({ entry, index, current, onNavigate }: { entry: MessageLocation; index: number; current: boolean; onNavigate: (id: string) => void }) {
  return <Tooltip>
      <TooltipTrigger asChild><Button
        variant="ghost" size="icon-sm" className="message-nav-mark"
        data-message-mark={entry.id}
        aria-label={`定位提问 ${index + 1}：${entry.title}`}
        aria-current={current ? "location" : undefined} tabIndex={current ? 0 : -1}
        onClick={() => onNavigate(entry.id)}
      ><span aria-hidden="true" /></Button></TooltipTrigger>
      <TooltipContent side="right" sideOffset={4} collisionPadding={12} className="message-nav-preview">
        <p className="line-clamp-3 break-words text-xs leading-5">{entry.title}</p>
        {entry.response && <p className="mt-1 line-clamp-3 break-words text-xs leading-5 text-muted-foreground">{entry.response}</p>}
      </TooltipContent>
    </Tooltip>;
}

type Props = {
  messages: UIMessage[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onNavigate: (id: string) => void;
  hasOlder: boolean;
  loadingOlder: boolean;
  disabled: boolean;
  onLoadOlder: () => void;
};

export function MessageNavigator({ messages, scrollRef, onNavigate, hasOlder, loadingOlder, disabled, onLoadOlder }: Props) {
  const entries = useMemo(() => messageLocations(messages), [messages]);
  const identity = JSON.stringify(entries.map(entry => entry.id));
  const messageIdentity = JSON.stringify(messages.map(message => message.id));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const marksRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLDivElement>(null);
  const navigatingRef = useRef<string | null>(null);
  const activeIndex = Math.max(0, entries.findIndex(entry => entry.id === activeId));

  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel) return;
    const observed = [...panel.querySelectorAll<HTMLElement>("[data-message-id]")];
    const elements = observed.filter(element => element.dataset.messageRole === "user");
    let frame = 0;
    const update = () => {
      frame = 0;
      if (navigatingRef.current && elements.some(element => element.dataset.messageId === navigatingRef.current)) return;
      navigatingRef.current = null;
      const line = panel.getBoundingClientRect().top + Math.min(80, panel.clientHeight / 4);
      let current: HTMLElement | undefined = elements[0];
      if (panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 2) current = elements.at(-1);
      else for (const element of elements) {
        if (element.getBoundingClientRect().top > line) break;
        current = element;
      }
      setActiveId(current?.dataset.messageId ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const releaseNavigation = () => { navigatingRef.current = null; schedule(); };
    const interruptWithKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) releaseNavigation();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    observed.forEach(element => observer.observe(element));
    panel.addEventListener("scroll", schedule, { passive: true });
    panel.addEventListener("scrollend", releaseNavigation);
    panel.addEventListener("wheel", releaseNavigation, { passive: true });
    panel.addEventListener("touchstart", releaseNavigation, { passive: true });
    panel.addEventListener("pointerdown", releaseNavigation);
    panel.addEventListener("keydown", interruptWithKey);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      panel.removeEventListener("scroll", schedule);
      panel.removeEventListener("scrollend", releaseNavigation);
      panel.removeEventListener("wheel", releaseNavigation);
      panel.removeEventListener("touchstart", releaseNavigation);
      panel.removeEventListener("pointerdown", releaseNavigation);
      panel.removeEventListener("keydown", interruptWithKey);
    };
  }, [messageIdentity, scrollRef]);

  useEffect(() => {
    const list = marksRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !current) return;
    const item = current.getBoundingClientRect(), bounds = list.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }, [activeIndex, identity]);

  function navigateTo(id: string) {
    navigatingRef.current = id;
    setActiveId(id);
    onNavigate(id);
  }

  const loadEarlier = <Button variant="ghost" size="icon-sm" className="message-nav-control" aria-label="加载更早的定位" title="加载更早的消息" disabled={disabled || loadingOlder} onClick={onLoadOlder}>
    {loadingOlder ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <ArrowUp data-icon="inline-start" />}
  </Button>;

  return <nav className="message-navigator" aria-label="当前对话定位">
    <Popover open={outlineOpen} onOpenChange={setOutlineOpen}>
      <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" className="message-nav-control" aria-label="打开对话目录" title="对话目录"><List /></Button></PopoverTrigger>
      <PopoverContent side="right" align="start" collisionPadding={12} className="message-nav-outline" aria-label="对话目录"
        onOpenAutoFocus={event => {
          const list = outlineRef.current;
          const current = list?.querySelector<HTMLButtonElement>('[aria-current="location"]');
          if (list && current) {
            event.preventDefault(); current.focus({ preventScroll: true });
            list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 2;
          }
        }}
        >
        <div className="px-3 py-2">
          <span className="text-sm font-medium">对话目录</span>
        </div>
        <div ref={outlineRef} className="chat-list-scroll flex min-h-0 flex-col overflow-y-auto px-1.5 pb-1.5">
          {entries.map((entry, index) => <Button key={entry.id} variant="ghost" className="message-nav-entry" data-location-id={entry.id} aria-label={`定位提问 ${index + 1}：${entry.title}`} aria-current={index === activeIndex ? "location" : undefined}
            onClick={() => { setOutlineOpen(false); navigateTo(entry.id); }}>
            <span className="min-w-0 flex-1 truncate text-left">{entry.title}</span>
          </Button>)}
        </div>
        {hasOlder && <div className="flex items-center gap-2 border-t px-3 py-2">{loadEarlier}<span className="text-xs text-muted-foreground">加载更早消息后可继续定位</span></div>}
      </PopoverContent>
    </Popover>
    <div className="message-nav-track">
      {hasOlder && loadEarlier}
      <TooltipProvider delayDuration={150}><div ref={marksRef} className="message-nav-marks chat-list-scroll" onKeyDown={event => {
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-message-mark]")];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
        buttons[next]?.focus({ preventScroll: true });
        const button = buttons[next], list = event.currentTarget;
        if (button) {
          const item = button.getBoundingClientRect(), bounds = list.getBoundingClientRect();
          if (item.top < bounds.top) list.scrollTop += item.top - bounds.top;
          else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
        }
      }}>
        {entries.map((entry, index) => <MessageMark key={entry.id} entry={entry} index={index} current={index === activeIndex} onNavigate={navigateTo} />)}
      </div></TooltipProvider>
    </div>
  </nav>;
}
