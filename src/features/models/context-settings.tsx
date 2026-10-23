"use client";

import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { formatNumber, t, tf } from "@/lib/locale";
import { modelRefKey, type ModelPreferences } from "@/lib/models/preferences-schema";

export function ContextSettings({ settings, busy, onChange }: { settings: ModelPreferences; busy: boolean; onChange: (settings: ModelPreferences) => void }) {
  return <details className="settings-disclosure">
    <summary className="settings-disclosure-trigger cursor-pointer text-foreground">{t("models.context.title")}</summary>
    <p className="my-3 text-sm text-muted-foreground">{t("models.context.description")}</p>
    <FieldGroup>
      {settings.library.filter(model => model.modes.includes("chat")).map(model => {
        const key = modelRefKey(model);
        const limit = settings.contextLimits?.[key] ?? { contextLength: null, maxOutputTokens: null };
        return <FieldSet key={key}>
          <FieldLegend variant="label">{model.name}</FieldLegend>
          <FieldDescription>{model.contextLength ? tf("models.context.catalog", { context: formatNumber(model.contextLength), output: model.maxOutputTokens ? formatNumber(model.maxOutputTokens) : t("models.unknown") }) : t("models.context.unknown")}</FieldDescription>
          <FieldGroup className="sm:flex-row">
            {([ ["contextLength", t("models.context.window"), 1024, 100_000_000], ["maxOutputTokens", t("models.context.output"), 1, 1_000_000] ] as const).map(([field, label, min, max]) => <Field key={field} data-disabled={busy}>
              <FieldLabel htmlFor={`${key}-${field}`}>{label}</FieldLabel>
              <Input id={`${key}-${field}`} type="number" min={min} max={max} step={1} disabled={busy}
                placeholder={t("models.context.automatic")} value={limit[field] ?? ""}
                onChange={event => onChange({ ...settings, contextLimits: { ...settings.contextLimits, [key]: { ...limit, [field]: event.target.value === "" ? null : Number(event.target.value) } } })} />
            </Field>)}
          </FieldGroup>
        </FieldSet>;
      })}
    </FieldGroup>
  </details>;
}
