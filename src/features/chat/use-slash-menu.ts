import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { localizeMessage, t } from "@/lib/locale";
import { useOpenSettings } from "@/features/settings/settings-context";
import { SETTINGS_PARAM, type SettingsSectionId } from "@/lib/settings/sections";
import { rememberSlashItem, recentSlashItems } from "@/features/chat/slash-recent";
import { filterSlashItems, SKILL_ICON, slashQuery, TEMPLATE_ICON, toolIcon, type SlashItem } from "@/features/chat/slash-menu";
import { toolLabel } from "@/features/chat/use-tools";
import type { ChatState } from "@/features/chat/use-chat-state";

type Options = Pick<ChatState,
  | "modelMode" | "input" | "setInput" | "tools" | "skills" | "assistants" | "choice" | "chooseTool" | "toggleSkill"
  | "applyAssistant" | "isPending" | "loadToolCatalog" | "removeLastChoice" | "handleTextareaKeyDown"
> & {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The tools the conversation's template allows, when it limits them. */
  allowedToolIds: string[] | undefined;
  modelCanCallTools: boolean;
  activeTemplateId: string | undefined;
};

/**
 * The slash menu: what the word being typed after a "/" offers (tools, skills,
 * templates), and moving through it from the keyboard. A menu closed with
 * Escape stays closed for that word only; a second "/" asks for it again.
 */
export function useSlashMenu(options: Options) {
  const {
    modelMode, input, setInput, tools, skills, assistants, choice, chooseTool, toggleSkill, applyAssistant, isPending, loadToolCatalog,
    removeLastChoice, handleTextareaKeyDown, textareaRef, allowedToolIds, modelCanCallTools, activeTemplateId,
  } = options;
  const openSettings = useOpenSettings();
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeRow, setActiveRow] = useState({ word: "", index: 0 });
  const slash = modelMode === "chat" ? slashQuery(input, caret) : null;
  const allItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = [];
    for (const tool of tools) {
      const user = tool.surface.user;
      if (!user || !tool.modeSupport.includes("chat") || (allowedToolIds && tool.surface.template !== "always" && !allowedToolIds.includes(tool.id))) continue;
      const label = tool.extensionId ? toolLabel(tool) : localizeMessage(tool.displayName);
      const blocked = !tool.available ? t("chat.slash.needsSetup") : user.run === "model" && !modelCanCallTools ? t("chat.slash.modelCannotCall") : undefined;
      items.push({
        key: `tool:${tool.id}`, group: tool.extensionId ? "plugins" : "tools", label, description: tool.extensionId ? tool.description : localizeMessage(tool.description),
        meta: tool.extensionName, icon: toolIcon(tool.id, Boolean(tool.extensionId)), chosen: choice.tool?.id === tool.id, blocked, terms: tool.id,
        // A tool waiting on setup leads there; one the model cannot call has nothing to offer.
        run: () => {
          if (tool.available) return chooseTool(tool);
          const section = tool.configEntry ? new URL(tool.configEntry, window.location.href).searchParams.get(SETTINGS_PARAM) : null;
          if (section) openSettings(section as SettingsSectionId);
        },
        opensSetup: !tool.available,
      });
    }
    for (const skill of skills) items.push({
      key: `skill:${skill.packageId}:${skill.skillId}`, group: "skills", label: skill.name, description: skill.description, meta: skill.plugin, icon: SKILL_ICON,
      chosen: choice.skills.some(item => item.packageId === skill.packageId && item.skillId === skill.skillId), run: () => toggleSkill(skill),
    });
    for (const template of assistants) {
      const name = template.builtin ? localizeMessage(template.config.name) : template.config.name;
      items.push({
        key: `template:${template.id}`, group: "templates", label: name,
        description: template.builtin ? localizeMessage(template.config.description) : template.config.description,
        icon: TEMPLATE_ICON, chosen: activeTemplateId === template.id, run: () => void applyAssistant(template.id),
      });
    }
    return items;
  }, [tools, skills, assistants, allowedToolIds, modelCanCallTools, choice.tool, choice.skills, activeTemplateId, chooseTool, toggleSkill, applyAssistant, openSettings]);
  const visibleItems = useMemo(() => {
    if (!slash) return [];
    if (slash.query) return filterSlashItems(allItems, slash.query);
    // Before anything is typed, only what can be used now, led by what was used last.
    const usable = allItems.filter(item => !item.blocked);
    const recent = recentSlashItems().flatMap(key => usable.filter(item => item.key === key)).slice(0, 4);
    return [...recent.map(item => ({ ...item, group: "recent" as const })), ...usable.filter(item => !recent.includes(item))];
  }, [allItems, slash]);
  // Said where the missing tools would be, so a short or empty list explains itself.
  const notice = slash && !modelCanCallTools ? t("chat.slash.toolLessNotice") : undefined;
  const open = Boolean(slash) && (visibleItems.length > 0 || Boolean(notice)) && dismissedAt !== slash?.start && !isPending;
  // The catalog may have changed in settings since this page loaded.
  const wasOpen = useRef(false);
  useEffect(() => { if (open && !wasOpen.current) void loadToolCatalog(); wasOpen.current = open; }, [open, loadToolCatalog]);
  // Each new word starts from the top of what it finds.
  const slashWord = `${slash?.start}:${slash?.query}`;
  const activeIndex = activeRow.word === slashWord ? activeRow.index : 0;
  const setActiveIndex = (index: number) => setActiveRow({ word: slashWord, index });
  function select(item: SlashItem) {
    if (!slash) return;
    if (item.blocked && !item.opensSetup) return;
    if (!item.blocked) rememberSlashItem(item.key);
    const end = slash.start + 1 + slash.query.length;
    setInput(current => `${current.slice(0, slash.start)}${current.slice(end)}`);
    setCaret(slash.start);
    item.run();
    const box = textareaRef.current, at = slash.start;
    requestAnimationFrame(() => { box?.focus(); box?.setSelectionRange(at, at); });
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((activeIndex + step + visibleItems.length) % visibleItems.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = visibleItems[Math.min(activeIndex, visibleItems.length - 1)];
        if (item) select(item);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setDismissedAt(slash?.start ?? null); return; }
    }
    // A second slash on a word whose menu was just closed asks for the menu again.
    if (event.key === "/" && slash && !slash.query && dismissedAt === slash.start && !event.nativeEvent.isComposing) { event.preventDefault(); setDismissedAt(null); return; }
    const box = event.currentTarget;
    const atStart = box.selectionStart === 0 && box.selectionEnd === 0;
    if (event.key === "Backspace" && !event.nativeEvent.isComposing && atStart && (choice.tool || choice.skills.length)) {
      event.preventDefault();
      removeLastChoice();
      return;
    }
    handleTextareaKeyDown(event);
  }
  function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setInput(event.target.value); setCaret(event.target.selectionStart);
    // A closed menu stays closed only for the word it was closed on.
    if (slashQuery(event.target.value, event.target.selectionStart)?.start !== dismissedAt) setDismissedAt(null);
  }
  return {
    listId, open, notice, items: visibleItems, activeIndex, setActiveIndex, query: slash?.query ?? "",
    select, dismiss: () => setDismissedAt(slash?.start ?? null), onKeyDown, onChange, onCaret: setCaret,
  };
}
