"use client";
import { forwardRef, type ComponentType } from "react";
import { X } from "lucide-react";
import { t, tf } from "@/lib/locale";
import type { MessageInvocation } from "@/lib/chat/invocation-schema";
import { SKILL_ICON, toolIcon } from "@/features/chat/slash-menu";

/**
 * What the composer has chosen, drawn as highlighted words in the message box's
 * own text flow. The words are not part of the text the user is editing: the box
 * starts its first line after them, so the caret sits right behind the last one.
 */
export type ChoiceWord = { key: string; label: string; icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; remove: () => void };

export const ComposerChoices = forwardRef<HTMLDivElement, { words: ChoiceWord[] }>(function ComposerChoices({ words }, ref) {
  return <div ref={ref} className="composer-choices">
    {words.map(word => {
      const Icon = word.icon;
      return <span key={word.key} data-choice-word="" className="composer-choice">
        <button type="button" className="composer-choice-icon" aria-label={tf("chat.slash.remove", { name: word.label })} onMouseDown={event => event.preventDefault()} onClick={word.remove}>
          <Icon aria-hidden={true} className="composer-choice-glyph" />
          <X aria-hidden="true" className="composer-choice-remove" />
        </button>
        {word.label}
      </span>;
    })}
  </div>;
});

/** The same words on a sent message. */
export function MessageChoices({ invocation }: { invocation: MessageInvocation }) {
  const words = [
    ...(invocation.tool ? [{ key: invocation.tool.id, label: invocation.tool.label, icon: toolIcon(invocation.tool.id, invocation.tool.id.startsWith("ext")) }] : []),
    ...(invocation.skills ?? []).map(skill => ({ key: `${skill.packageId}:${skill.skillId}`, label: skill.label, icon: SKILL_ICON })),
  ];
  return <p className="message-choices" aria-label={t("chat.slash.usedLabel")}>
    {words.map(word => { const Icon = word.icon; return <span key={word.key} className="composer-choice"><Icon aria-hidden={true} className="composer-choice-glyph" />{word.label}</span>; })}
    {invocation.document ? <span className="message-choices-document">{invocation.document.filename}</span> : null}
  </p>;
}
