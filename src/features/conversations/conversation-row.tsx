"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatTime } from "@/features/chat/page-utils";
import { t } from "@/lib/locale";
import type { Conversation } from "@/features/conversations/api-client";

type Props = {
  chat: Conversation; selected: boolean; disabled: boolean; selectionFull: boolean;
  select: () => void; open: () => void;
  update: (value: { pinned?: boolean; archived?: boolean; tags?: string[] }) => Promise<boolean>;
  download: (format: "markdown" | "json") => void;
};

export function ConversationRow({ chat, selected, disabled, selectionFull, select, open, update, download }: Props) {
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState("");
  return <article aria-label={chat.title} className="rounded-lg bg-card p-4 shadow-card">
    <div className="flex items-start gap-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-foreground" aria-label={`${t("conversationRow.select")} ${chat.title}`} checked={selected} disabled={disabled || (!selected && selectionFull)} onChange={select} />
      <div className="min-w-0 flex-1">
        <h2 className="break-words font-semibold tracking-title">{chat.title}</h2>
        <p className="label-mono mt-1">{chat.messageCount} {t("chat.conversations.messageCountUnit")} · {formatTime(chat.lastMessageAt)}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chat.pinned && <Badge>{t("conversationRow.pinned")}</Badge>}{chat.archived && <Badge variant="secondary">{t("conversations.filter.stateArchived")}</Badge>}
          {chat.tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}
        </div>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled} onClick={open}>{chat.archived ? t("conversationRow.reopenAndOpen") : t("asset.openChat")}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void update({ pinned: !chat.pinned })}>{chat.pinned ? t("conversationRow.unpin") : t("conversationRow.pin")}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void update({ archived: !chat.archived })}>{chat.archived ? t("conversationRow.restore") : t("conversationRow.archive")}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setTags(chat.tags.join(", ")); setEditing(true); }}>{t("conversationRow.editTags")}</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => download("markdown")}>{`${t("conversationRow.export")} Markdown`}</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => download("json")}>{`${t("conversationRow.export")} JSON`}</Button>
    </div>
    {editing && <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); void update({ tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }).then(saved => { if (saved) setEditing(false); }); }}>
      <label className="block text-sm">{t("conversationRow.tagsLabel")}<Input className="mt-1.5" autoFocus value={tags} disabled={disabled} onChange={event => setTags(event.target.value)} maxLength={300} /></label>
      <p className="text-xs text-muted-foreground">{t("conversationRow.tagsHint")}</p>
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled}>{t("conversationRow.saveTags")}</Button><Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => setEditing(false)}>{t("chat.common.cancel")}</Button></div>
    </form>}
  </article>;
}
