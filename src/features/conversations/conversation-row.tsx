"use client";
import { useLocale } from "@/lib/locale/client";

import { formatRelativeTime, t, tf } from "@/lib/locale";

import { useState } from "react";
import { Archive, ArchiveRestore, Download, MoreHorizontal, Pin, PinOff, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { formatTime } from "@/features/chat/page-utils";
import type { Conversation } from "@/features/conversations/api-client";
import { removalKey } from "@/lib/ui/removal";

type Props = {
  chat: Conversation; selected: boolean; disabled: boolean; selectionFull: boolean;
  select: () => void; open: () => void;
  update: (value: { pinned?: boolean; archived?: boolean; tags?: string[] }) => Promise<boolean>;
  download: (format: "markdown" | "json") => void;
};

export function ConversationRow({ chat, selected, disabled, selectionFull, select, open, update, download }: Props) {
  useLocale();
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState("");
  return <article aria-label={chat.title} {...removalKey(chat.id)} data-selected={selected} className="item-row item-row-stack">
    {/* The columns match the list head: select, title, tags, messages, last activity, actions. */}
    <div className="data-row">
      <input type="checkbox" className="item-row-action size-3.5 shrink-0 accent-foreground" aria-label={`${t("conversationRow.select")} ${chat.title}`} checked={selected} disabled={disabled || (!selected && selectionFull)} onChange={select} />
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="min-w-0 text-sm font-medium"><button type="button" disabled={disabled} onClick={open} aria-label={chat.archived ? t("conversationRow.reopenAndOpen") : t("asset.openChat")} title={chat.title} className="item-row-open block w-full truncate">{chat.title}</button></h2>
        {chat.pinned && <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Pin aria-hidden="true" className="size-3" /><span className="max-sm:sr-only">{t("conversationRow.pinned")}</span></span>}
        {chat.archived && <span className="shrink-0 text-xs text-muted-foreground">{t("conversations.filter.stateArchived")}</span>}
      </div>
      <p className="col-meta col-optional flex gap-1">{chat.tags.map(tag => <span key={tag} className="rounded bg-muted px-1.5 leading-5">{tag}</span>)}</p>
      <span className="col-meta col-end col-optional">{chat.messageCount}</span>
      <time className="col-meta col-end" dateTime={chat.lastMessageAt} title={formatTime(chat.lastMessageAt)}>{formatRelativeTime(chat.lastMessageAt)}</time>
      <div className="flex shrink-0 items-center justify-end gap-1">
        <Button size="icon-sm" variant="ghost" className="item-row-action" aria-label={chat.pinned ? t("conversationRow.unpin") : t("conversationRow.pin")} title={chat.pinned ? t("conversationRow.unpin") : t("conversationRow.pin")} disabled={disabled} onClick={() => void update({ pinned: !chat.pinned })}>{chat.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild><Button id={`chat-actions-${chat.id}`} size="icon-sm" variant="ghost" className="item-row-action" aria-label={tf("ui.assistants.moreActionsFor", { v0: chat.title })} disabled={disabled}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (editing) event.preventDefault(); }}><DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => void update({ archived: !chat.archived })}>{chat.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}{chat.archived ? t("conversationRow.restore") : t("conversationRow.archive")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setTags(chat.tags.join(", ")); setEditing(true); }}><Tags aria-hidden="true" />{t("conversationRow.editTags")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => download("markdown")}><Download aria-hidden="true" />{`${t("conversationRow.export")} Markdown`}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => download("json")}><Download aria-hidden="true" />{`${t("conversationRow.export")} JSON`}</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    {editing && <form className="item-row-action surface-enter pl-7" onSubmit={event => { event.preventDefault(); void update({ tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }).then(saved => { if (saved) setEditing(false); }); }}>
      <FieldGroup className="gap-2"><Field className="gap-2"><FieldLabel htmlFor={`chat-tags-${chat.id}`}>{t("conversationRow.tagsLabel")}</FieldLabel><Input id={`chat-tags-${chat.id}`} autoFocus value={tags} disabled={disabled} onChange={event => setTags(event.target.value)} maxLength={300} /><FieldDescription>{t("conversationRow.tagsHint")}</FieldDescription></Field>
        <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled}>{t("conversationRow.saveTags")}</Button><Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => { setEditing(false); document.getElementById(`chat-actions-${chat.id}`)?.focus(); }}>{t("chat.common.cancel")}</Button></div>
      </FieldGroup>
    </form>}
  </article>;
}
