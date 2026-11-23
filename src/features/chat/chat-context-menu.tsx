import { useRef, useState, type KeyboardEvent, type MouseEvent, type UIEvent } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, Copy, Image, ImagePlus, Redo2, Scissors, SquareDashed, Trash2, Undo2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { focusHasMovedOn } from "@/components/ui/focus-return";
import { useToast } from "@/components/ui/toast";
import { t } from "@/lib/locale";
import { assetIdFromUrl } from "@/lib/media/message-codec";
import { capturedSelection, copyChatImage, copyChatSelection } from "./clipboard-content";
import { keyboardMenuPoint } from "./context-menu-position";

const editCommands = ["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"] as const;
type Command = typeof editCommands[number] | "copyImage" | "attachImage";
type Action = { command: Command; enabled: boolean; run: () => boolean | Promise<boolean> };
type Target = { anchor: HTMLElement; groups: Action[][]; editable?: boolean; restore: () => boolean };
type Opening = Target & { x: number; y: number; conversationId: string | null; open: boolean };

const commandIcons = { undo: Undo2, redo: Redo2, cut: Scissors, copy: Copy, paste: ClipboardPaste, delete: Trash2, selectAll: SquareDashed, copyImage: Image, attachImage: ImagePlus };
const editShortcuts: Partial<Record<Command, string>> = {
  undo: "Ctrl+Z", redo: "Ctrl+Y", cut: "Ctrl+X", copy: "Ctrl+C", paste: "Ctrl+V", delete: "Del", selectAll: "Ctrl+A",
};

function textareaTarget(input: HTMLTextAreaElement): Target {
  const value = input.value;
  const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = input;
  const selected = end > start;
  input.focus({ preventScroll: true });
  input.setSelectionRange(start, end, direction);
  const restore = () => {
    if (!input.isConnected || input.value !== value) return false;
    const { scrollTop, scrollLeft } = input;
    input.focus({ preventScroll: true });
    input.setSelectionRange(start, end, direction);
    input.scrollTop = scrollTop;
    input.scrollLeft = scrollLeft;
    return true;
  };
  const actions = editCommands.map(command => ({
    command,
    enabled: command === "copy" ? selected : command === "selectAll" ? value.length > 0 : !input.readOnly && !input.disabled && (
      command === "paste" ? Boolean(window.riaDesktop?.pasteIntoChat || navigator.clipboard?.read)
        : command === "cut" || command === "delete" ? selected : document.queryCommandEnabled(command)
    ),
    run: () => {
      if (command === "selectAll") { input.select(); return true; }
      if (command === "paste") return pasteInto(input);
      // Chromium owns the edit history and fires the same input event as a
      // keyboard edit. Setting the controlled value here loses native undo.
      return document.execCommand(command);
    },
  }));
  return { anchor: input, groups: [actions.slice(0, 2), actions.slice(2, -1), actions.slice(-1)], editable: true, restore };
}

async function pasteInto(input: HTMLTextAreaElement) {
  if (window.riaDesktop?.pasteIntoChat) return window.riaDesktop.pasteIntoChat();

  const { value, selectionStart, selectionEnd } = input;
  const data = new DataTransfer();
  for (const item of await navigator.clipboard.read()) {
    for (const type of item.types) {
      if (type === "text/plain" || type === "text/html") data.setData(type, await (await item.getType(type)).text());
      if (type === "image/png") data.items.add(new File([await item.getType(type)], "clipboard.png", { type }));
    }
  }
  if (document.activeElement !== input || input.readOnly || input.disabled || input.value !== value ||
    input.selectionStart !== selectionStart || input.selectionEnd !== selectionEnd) return true;
  const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
  const insert = input.dispatchEvent(event);
  const text = data.getData("text/plain");
  return !insert || !text || document.execCommand("insertText", false, text);
}

function messageBodyFor(target: HTMLElement) {
  if (target.closest("[data-chat-copy-ignore], .answer-fold-toggle, .code-block-head, .chat-picture-actions")) return null;
  return target.closest<HTMLElement>("[data-chat-copy-body]");
}

function bodyTarget(target: HTMLElement, attachImage?: (url: string) => Promise<void>): Target | null {
  const body = messageBodyFor(target);
  if (!body) return null;
  const scope = target.closest("pre") ?? body;
  const selection = window.getSelection();
  if (!selection) return null;
  const original = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const backward = original && selection.anchorNode === original.endContainer && selection.anchorOffset === original.endOffset;
  let range = original && !original.collapsed && original.intersectsNode(body) ? original : null;
  const image = target instanceof HTMLImageElement ? target : target.closest("[data-chat-image-preview]")?.querySelector("img");
  if (image && !range?.intersectsNode(image)) {
    range = document.createRange();
    range.selectNode(image);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const captured = range && capturedSelection(selection, range, body);
  const active = document.activeElement;
  const anchor = active instanceof HTMLElement && scope.contains(active) ? active : scope;
  const restore = () => {
    if (!scope.isConnected) return false;
    anchor.focus({ preventScroll: true });
    if (original?.startContainer.isConnected && original.endContainer.isConnected) {
      if (backward) selection.setBaseAndExtent(original.endContainer, original.endOffset, original.startContainer, original.startOffset);
      else selection.setBaseAndExtent(original.startContainer, original.startOffset, original.endContainer, original.endOffset);
    } else if (image) {
      selection.removeAllRanges();
    }
    return true;
  };

  const actions: Action[] = [];
  if (image) actions.push({ command: "copyImage", enabled: true, run: () => copyChatImage(image) });
  const source = image?.getAttribute("src");
  if (attachImage && source && assetIdFromUrl(source)) actions.push({ command: "attachImage", enabled: true, run: async () => {
    await attachImage(source);
    return true;
  } });
  if (!image || captured?.plain) actions.push({
    command: "copy", enabled: Boolean(captured && (captured.plain || captured.hasImages)),
    run: () => captured ? copyChatSelection(captured) : false,
  });
  actions.push({ command: "selectAll", enabled: true, run: () => {
    const all = document.createRange();
    all.selectNodeContents(scope);
    selection.removeAllRanges();
    selection.addRange(all);
    return true;
  } });
  return { anchor, groups: [actions], restore };
}

export function useChatContextMenu(conversationId: string | null, attachImage?: (url: string) => Promise<void>) {
  const [opening, setOpening] = useState<Opening | null>(null);
  const acted = useRef<Target["restore"] | null>(null);
  const latestRestore = useRef<Target["restore"] | null>(null);
  const toast = useToast();
  const current = opening?.conversationId === conversationId ? opening : null;

  function show(target: HTMLElement, event: MouseEvent | KeyboardEvent, point?: { x: number; y: number }) {
    const menu = target instanceof HTMLTextAreaElement && target.hasAttribute("data-chat-draft") ? textareaTarget(target) : bodyTarget(target, attachImage);
    if (!menu) return;
    event.preventDefault();
    latestRestore.current = menu.restore;
    setOpening({ ...menu, ...(point ?? keyboardMenuPoint(menu.anchor)), open: true, conversationId });
  }

  function close() {
    setOpening(previous => previous?.open && previous === current ? { ...previous, open: false } : previous);
  }

  async function run(action: Action) {
    if (!current?.open) return;
    if (!current.restore() && (current.editable || action.command === "selectAll")) return;
    acted.current = current.restore;
    let success = false;
    try { success = await action.run(); } catch { /* Report the failed clipboard action below. */ }
    if (!success && ["copy", "copyImage", "cut", "paste"].includes(action.command)) {
      toast({ title: t(action.command === "paste" ? "chat.contextMenu.pasteFailed" : "chat.messages.copyAnswerRefused"), tone: "error" });
    }
  }

  return {
    events: {
      onMouseDownCapture(event: MouseEvent) {
        if (event.button !== 2 || !(event.target instanceof HTMLElement)) return;
        const target = event.target;
        if (target instanceof HTMLTextAreaElement && target.hasAttribute("data-chat-draft")) {
          if (target.selectionStart !== target.selectionEnd) event.preventDefault();
          return;
        }
        if (messageBodyFor(target) && window.getSelection()?.isCollapsed === false) event.preventDefault();
      },
      onContextMenu(event: MouseEvent) {
        if (event.target instanceof HTMLElement) show(event.target, event, { x: event.clientX, y: event.clientY });
      },
      onKeyDownCapture(event: KeyboardEvent) {
        if (event.nativeEvent.isComposing || !(event.target instanceof HTMLElement)) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) show(event.target, event);
      },
      onScrollCapture(event: UIEvent<HTMLElement>) {
        // A scroll in the workspace can move the source out from under the fixed
        // menu. Its own portaled scroll area can still be used to reach commands.
        if (current?.open && event.target instanceof Node && event.currentTarget.contains(event.target)) {
          close();
        }
      },
    },
    menu: current && (
      <DropdownMenu modal={false} open={current.open} onOpenChange={open => {
        if (!open) close();
      }}>
        {createPortal(<DropdownMenuTrigger asChild>
          <span aria-hidden="true" className="pointer-events-none fixed size-px" style={{ left: current.x, top: current.y }} />
        </DropdownMenuTrigger>, document.body)}
        <DropdownMenuContent className="chat-context-menu" aria-label={t("chat.contextMenu.label")} align="start" sideOffset={2} collisionPadding={8}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (latestRestore.current !== current.restore) return;
            if (acted.current !== current.restore && !focusHasMovedOn()) current.restore();
            acted.current = null;
            latestRestore.current = null;
            setOpening(previous => previous?.restore === current.restore ? null : previous);
          }}>
          {current.groups.map((actions, index) => (
            <DropdownMenuGroup key={actions[0].command}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {actions.map(action => {
                const Icon = commandIcons[action.command];
                const shortcut = current.editable && editShortcuts[action.command];
                return <DropdownMenuItem key={action.command} disabled={!action.enabled} onSelect={() => void run(action)}>
                  <Icon aria-hidden="true" />
                  <span>{t(`chat.contextMenu.${action.command}`)}</span>
                  {shortcut ? <kbd aria-hidden="true">{shortcut}</kbd> : null}
                </DropdownMenuItem>;
              })}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };
}
