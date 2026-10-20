"use client";

import { useState } from "react";
import { Languages } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  return <SettingsSection title={<><Languages aria-hidden="true" className="size-4" />{t("settings.language.title")}</>}>
    <FieldGroup>
      <Field orientation="horizontal" className="settings-field">
        <FieldContent><FieldLabel htmlFor="interface-language">{t("settings.language.label")}</FieldLabel><FieldDescription>{t("settings.language.description")}</FieldDescription></FieldContent>
        <SelectField id="interface-language" value={locale} disabled={saving} onValueChange={value => void choose(value)}>
          <SelectOption value="zh-CN">简体中文</SelectOption>
          <SelectOption value="en-US">English</SelectOption>
        </SelectField>
      </Field>
      {failed && <Alert variant="destructive"><AlertDescription>{t("settings.language.saveFailed")}</AlertDescription></Alert>}
    </FieldGroup>
  </SettingsSection>;
}
