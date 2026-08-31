"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatTime } from "@/features/chat/page-utils";
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
  return <article aria-label={chat.title} className="rounded-xl border bg-card p-4">
    <div className="flex items-start gap-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-primary" aria-label={`选择 ${chat.title}`} checked={selected} disabled={disabled || (!selected && selectionFull)} onChange={select} />
      <div className="min-w-0 flex-1">
        <h2 className="break-words font-semibold">{chat.title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{chat.messageCount} 条消息 · {formatTime(chat.lastMessageAt)}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chat.pinned && <Badge>已置顶</Badge>}{chat.archived && <Badge variant="secondary">已归档</Badge>}
          {chat.tags.map(tag => <Badge key={tag} variant="secondary">{tag}</Badge>)}
        </div>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" disabled={disabled} onClick={open}>{chat.archived ? "恢复并打开" : "打开会话"}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void update({ pinned: !chat.pinned })}>{chat.pinned ? "取消置顶" : "置顶"}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void update({ archived: !chat.archived })}>{chat.archived ? "恢复" : "归档"}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setTags(chat.tags.join(", ")); setEditing(true); }}>编辑标签</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => download("markdown")}>导出 Markdown</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => download("json")}>导出 JSON</Button>
    </div>
    {editing && <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); void update({ tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) }).then(saved => { if (saved) setEditing(false); }); }}>
      <label className="block text-sm">标签（逗号分隔）<Input autoFocus value={tags} disabled={disabled} onChange={event => setTags(event.target.value)} maxLength={300} /></label>
      <p className="text-xs text-muted-foreground">最多 8 个，每个最多 32 字符；统一小写，留空可清除。</p>
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={disabled}>保存标签</Button><Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => setEditing(false)}>取消</Button></div>
    </form>}
  </article>;
}
