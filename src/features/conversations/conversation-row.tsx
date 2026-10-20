"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf } from "@/lib/locale";

import { useState } from "react";
import { Archive, ArchiveRestore, Download, MoreHorizontal, Pin, PinOff, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { formatTime } from "@/features/chat/page-utils";
import type { Conversation } from "@/features/conversations/api-client";

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
  return <article aria-label={chat.title} data-selected={selected} className="management-row rounded-xl px-3 py-3 sm:px-4">
    <div className="flex items-center gap-3">
      <input type="checkbox" className="size-3.5 shrink-0 accent-foreground" aria-label={`${t("conversationRow.select")} ${chat.title}`} checked={selected} disabled={disabled || (!selected && selectionFull)} onChange={select} />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium"><button type="button" disabled={disabled} onClick={open} aria-label={chat.archived ? t("conversationRow.reopenAndOpen") : t("asset.openChat")} title={chat.title} className="block w-full truncate rounded-sm text-left transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{chat.title}</button></h2>
        <p className="mt-1 text-xs text-muted-foreground">{chat.messageCount} {t("chat.conversations.messageCountUnit")} · {formatTime(chat.lastMessageAt)}</p>
        {(chat.pinned || chat.archived || chat.tags.length > 0) ? <div className="mt-1.5 flex flex-wrap gap-1.5">
          {chat.pinned && <Badge>{t("conversationRow.pinned")}</Badge>}{chat.archived && <Badge variant="secondary">{t("conversations.filter.stateArchived")}</Badge>}
          {chat.tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}
        </div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label={chat.pinned ? t("conversationRow.unpin") : t("conversationRow.pin")} title={chat.pinned ? t("conversationRow.unpin") : t("conversationRow.pin")} disabled={disabled} onClick={() => void update({ pinned: !chat.pinned })}>{chat.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild><Button id={`chat-actions-${chat.id}`} size="icon-sm" variant="ghost" aria-label={tf("ui.assistants.moreActionsFor", { v0: chat.title })} disabled={disabled}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (editing) event.preventDefault(); }}><DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => void update({ archived: !chat.archived })}>{chat.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}{chat.archived ? t("conversationRow.restore") : t("conversationRow.archive")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setTags(chat.tags.join(", ")); setEditing(true); }}><Tags aria-hidden="true" />{t("conversationRow.editTags")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => download("markdown")}><Download aria-hidden="true" />{`${t("conversationRow.export")} Markdown`}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => download("json")}><Download aria-hidden="true" />{`${t("conversationRow.export")} JSON`}</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    {editing && <form className="mt-3 pl-6" onSubmit={event => { event.preventDefault(); void update({ tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }).then(saved => { if (saved) setEditing(false); }); }}>
      <FieldGroup className="gap-2"><Field className="gap-2"><FieldLabel htmlFor={`chat-tags-${chat.id}`}>{t("conversationRow.tagsLabel")}</FieldLabel><Input id={`chat-tags-${chat.id}`} autoFocus value={tags} disabled={disabled} onChange={event => setTags(event.target.value)} maxLength={300} /><FieldDescription>{t("conversationRow.tagsHint")}</FieldDescription></Field>
        <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled}>{t("conversationRow.saveTags")}</Button><Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => { setEditing(false); document.getElementById(`chat-actions-${chat.id}`)?.focus(); }}>{t("chat.common.cancel")}</Button></div>
      </FieldGroup>
    </form>}
  </article>;
}
