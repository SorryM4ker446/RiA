"use client";

import { useState } from "react";
import { Languages } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SelectField, SelectOption } from "@/components/ui/select";
import { SettingsSection } from "./settings-section";
import { t, type Locale } from "@/lib/locale";
import { saveLocale, useLocale } from "@/lib/locale/client";

export function LanguageSettings() {
  const locale = useLocale();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  async function choose(value: string) {
    if (saving || value === locale) return;
    setSaving(true);
    setFailed(false);
    try { await saveLocale(value as Locale); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return <SettingsSection
    title={<><Languages aria-hidden="true" className="size-4" />{t("settings.language.title")}</>}
    action={<SelectField id="interface-language" aria-label={t("settings.language.label")} aria-describedby="interface-language-description" size="sm" value={locale} disabled={saving} onValueChange={value => void choose(value)}>
      <SelectOption value="zh-CN">简体中文</SelectOption>
      <SelectOption value="en-US">English</SelectOption>
    </SelectField>}
  >
    <div className="flex flex-col gap-3">
      <p id="interface-language-description" className="text-xs leading-relaxed text-muted-foreground">{t("settings.language.description")}</p>
      {failed && <Alert variant="destructive"><AlertDescription>{t("settings.language.saveFailed")}</AlertDescription></Alert>}
    </div>
  </SettingsSection>;
}
