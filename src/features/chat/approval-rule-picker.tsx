"use client";

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
export function ApprovalRulePicker({ rule, locked, saving, onSelect }: {
  /** Null until a conversation exists; a new one starts from the default rule. */
  rule: ApprovalRule | null;
  locked: boolean;
  saving: boolean;
  onSelect: (rule: ApprovalRule) => Promise<boolean>;
}) {
  useLocale();
  const toast = useToast();
  const current = rule ?? null;
  const name = current ? t(`approval.rule.${current}`) : t("approval.label");

  async function choose(value: string) {
    const next = readApprovalRule(value);
    if (next === current || locked || saving) return;
    if (await onSelect(next)) toast(tf("approval.changed", { rule: t(`approval.rule.${next}`) }));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="max-w-[12rem]" disabled={locked}
          aria-label={tf("approval.current", { rule: name })} title={locked ? t("approval.lockedWhileGenerating") : current ? t(`approval.ruleHint.${current}`) : t("approval.label")}>
          <ShieldCheck aria-hidden="true" data-icon="inline-start" />
          {/* On a phone the row keeps one line: the name folds away and the button keeps it as its label. */}
          <span className="min-w-0 truncate max-sm:sr-only">{name}</span>
          <ChevronDown aria-hidden="true" className="opacity-60 max-sm:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
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
