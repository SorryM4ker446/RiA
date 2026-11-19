import { t, tf, type Locale } from "@/lib/locale";

/** How RiA's notice that sub-agents ended reads in the conversation and its outline. */
export function subagentNoticeText(titles: readonly string[], locale?: Locale) {
  const names = titles.map(title => tf("chat.subagent.quoted", { title }, locale)).join(t("chat.subagent.separator", locale));
  return tf("chat.subagent.noticeLine", { names }, locale);
}
