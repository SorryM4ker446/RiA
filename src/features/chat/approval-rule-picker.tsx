"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { APPROVAL_RULES, readApprovalRule, type ApprovalRule } from "@/lib/approvals/rules";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

/**
 * What the model may do in this conversation's workspace without asking.
 *
 * Sits beside the folder picker: the folder says where the model works, the
 * rule says what waits for the user there. In a task's conversation it shows
 * and changes the task's rule.
 */
/**
 * The default rule as last read, so a conversation not made yet names it from
 * its first frame instead of changing its label (and its width) once it is read.
 */
const REMEMBERED_DEFAULT_KEY = "chat:approval-default";
const noSubscription = () => () => {};
function useRememberedDefault(): ApprovalRule | null {
  const value = useSyncExternalStore(noSubscription, () => { try { return window.localStorage.getItem(REMEMBERED_DEFAULT_KEY) ?? ""; } catch { return ""; } }, () => "");
  return value ? readApprovalRule(value) : null;
}

export function ApprovalRulePicker({ rule, locked, saving, onSelect }: {
  /** Null until a conversation exists; a new one starts from the default rule. */
  rule: ApprovalRule | null;
  locked: boolean;
  saving: boolean;
  onSelect: (rule: ApprovalRule) => Promise<boolean>;
}) {
  useLocale();
  const toast = useToast();
  // A conversation not made yet will start from the default rule in Settings; that is what it shows.
  const [initial, setInitial] = useState<ApprovalRule | null>(null);
  const remembered = useRememberedDefault();
  useEffect(() => {
    if (rule) return;
    let live = true;
    void fetch("/api/approval-preferences", { cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (!live || !payload?.data?.defaultRule) return;
        const read = readApprovalRule(payload.data.defaultRule);
        setInitial(read);
        try { window.localStorage.setItem(REMEMBERED_DEFAULT_KEY, read); } catch { /* Only a starting label. */ }
      })
      .catch(() => { /* Until it is read the picker names the setting instead. */ });
    return () => { live = false; };
  }, [rule]);
  const current = rule ?? initial ?? remembered;
  const name = current ? t(`approval.rule.${current}`) : t("approval.label");

  async function choose(value: string) {
    const next = readApprovalRule(value);
    if (next === current || locked || saving) return;
    if (await onSelect(next)) toast(tf("approval.changed", { rule: t(`approval.rule.${next}`) }));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="approval-rule-picker composer-control max-w-[12rem]" disabled={locked}
          aria-label={tf("approval.current", { rule: name })} title={locked ? t("approval.lockedWhileGenerating") : current ? t(`approval.ruleHint.${current}`) : t("approval.label")}>
          <ShieldCheck aria-hidden="true" data-icon="inline-start" />
          {/* On a phone the row keeps one line: the name folds away and the button keeps it as its label. */}
          <span className="min-w-0 truncate max-sm:sr-only">{name}</span>
          <ChevronDown aria-hidden="true" className="opacity-60 max-sm:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t("approval.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current ?? ""} onValueChange={value => void choose(value)}>
          {APPROVAL_RULES.map(value => (
            <DropdownMenuRadioItem key={value} value={value}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{t(`approval.rule.${value}`)}</span>
                <span className="text-xs text-muted-foreground">{t(`approval.ruleHint.${value}`)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
