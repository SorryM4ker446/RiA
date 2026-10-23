"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Loader2, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PageHeader } from "@/components/layout/page-header";
import { Reveal } from "@/components/ui/reveal";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/features/settings/settings-section";
import { SettingsLink, useSettingsDirty } from "@/features/settings/settings-context";
import { Input } from "@/components/ui/input";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { SelectField, SelectOption } from "@/components/ui/select";
import { jsonRequest, settingsRequest } from "@/features/settings/api-client";
import { libraryModel, modelRefKey, type ModelPreferences } from "@/lib/models/preferences-schema";
import { parseModelRefValue } from "@/features/chat/preferences";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";

/** Scrolls to a part of this section without writing a fragment into the page's address. */
function scrollToPart(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Provider keys, connection options and the default chat model. */
export function ServiceSettings() {
  useLocale();
  const toast = useToast();
  const windowDesktop = useDesktopRuntime();
  const [settings, setSettings] = useState<DesktopSettingsView | null>(null);
  const [modelState, setModelState] = useState<ModelPreferences | null>(null);
  const [defaultModel, setDefaultModel] = useState("");
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [outboundProxyUrl, setOutboundProxyUrl] = useState("");
  const [openrouterSiteName, setOpenrouterSiteName] = useState("");
  const [openrouterHttpReferer, setOpenrouterHttpReferer] = useState("");
  const [clearOpenrouterApiKey, setClearOpenrouterApiKey] = useState(false);
  const [clearTavilyApiKey, setClearTavilyApiKey] = useState(false);
  const [clearDeepseekApiKey, setClearDeepseekApiKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.riaDesktop;
    if (!bridge) {
      queueMicrotask(() => setIsLoading(false));
      return;
    }

    Promise.all([
      bridge.getSettings(),
      bridge.getRuntimeInfo(),
      // The readiness steps describe what is configured, and two of the three
      // live in model settings rather than in the desktop store. A failure here
      // must not block the section, so it is settled separately below.
      settingsRequest<{ data: ModelPreferences }>("/api/models")
        .catch((error: unknown) => {
          setModelError(error instanceof Error ? error.message : t("ui.settings.couldNotLoadModelConfiguration"));
          return null;
        }),
    ])
      .then(([loadedSettings, loadedRuntime, models]) => {
        setSettings(loadedSettings);
        setRuntime(loadedRuntime);
        if (models?.data) {
          setModelState(models.data);
          setDefaultModel(models.data.chat.model ? modelRefKey(models.data.chat.model) : "");
        }
        setOutboundProxyUrl(loadedSettings.outboundProxyUrl);
        setOpenrouterSiteName(loadedSettings.openrouterSiteName);
        setOpenrouterHttpReferer(loadedSettings.openrouterHttpReferer);
        // The desktop shell reopens settings with `saved=1` after a restart, or
        // `welcome=1` on a first run. Each is said once: the flag leaves the
        // address as soon as it is read, so reopening settings later is quiet.
        const url = new URL(window.location.href);
        if (url.searchParams.get("saved") === "1") setNotice(t("settings.notice.saved"));
        else if (url.searchParams.get("welcome") === "1") setNotice(t("settings.notice.welcome"));
        if (url.searchParams.has("saved") || url.searchParams.has("welcome")) {
          url.searchParams.delete("saved");
          url.searchParams.delete("welcome");
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        }
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : t("settings.error.load")))
      .finally(() => setIsLoading(false));
  }, []);

  const modelCount = modelState?.library.length ?? 0;
  const hasDefaultModel = Boolean(modelState && libraryModel(modelState, "chat", modelState.chat.model));
  const savedDefault = modelState?.chat.model ? modelRefKey(modelState.chat.model) : "";
  // The connection fields start empty until the desktop settings load, so an
  // edit counts against what was loaded, or against empty when nothing was.
  const loaded = settings ?? { outboundProxyUrl: "", openrouterSiteName: "", openrouterHttpReferer: "" };
  const keysChanged = Boolean(openrouterApiKey || tavilyApiKey || deepseekApiKey || clearOpenrouterApiKey || clearTavilyApiKey || clearDeepseekApiKey)
    || outboundProxyUrl !== loaded.outboundProxyUrl || openrouterSiteName !== loaded.openrouterSiteName || openrouterHttpReferer !== loaded.openrouterHttpReferer;
  useSettingsDirty(!isSaving && (keysChanged || defaultModel !== savedDefault));

  async function saveDefaultModel() {
    if (savingModel) return;
    setSavingModel(true);
    setModelError(null);
    try {
      // Read the other preferences at save time so editing this field preserves them.
      const { data: latest } = await settingsRequest<{ data: ModelPreferences }>("/api/models");
      const { data } = await settingsRequest<{ data: ModelPreferences }>("/api/models", jsonRequest("PUT", {
        ...latest, chat: { ...latest.chat, model: parseModelRefValue(defaultModel) },
      }));
      setModelState(data);
      setDefaultModel(data.chat.model ? modelRefKey(data.chat.model) : "");
      toast(t("ui.settings.defaultChatModelSavedNewConversations"));
    } catch (error) {
      setModelError(error instanceof Error ? error.message : t("ui.settings.couldNotSaveDefaultModel"));
    } finally {
      setSavingModel(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bridge = window.riaDesktop;
    if (!bridge) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await bridge.saveSettings({
        openrouterApiKey,
        tavilyApiKey,
        deepseekApiKey,
        clearOpenrouterApiKey,
        clearTavilyApiKey,
        clearDeepseekApiKey,
        outboundProxyUrl,
        openrouterSiteName,
        openrouterHttpReferer,
      });
      setSettings(result.settings);
      setOpenrouterApiKey("");
      setTavilyApiKey("");
      setDeepseekApiKey("");
      setClearOpenrouterApiKey(false);
      setClearTavilyApiKey(false);
      setClearDeepseekApiKey(false);
      setNotice(t("settings.notice.saving"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.error.save"));
      setIsSaving(false);
    }
  }

  const steps = settings ? [
    { done: settings.hasOpenrouterApiKey || settings.hasDeepseekApiKey, known: true, label: t("settings.step.provider"), target: "service-keys", detail: t("ui.settings.configureAtLeastOneModelProvider") },
    { done: modelCount > 0, known: Boolean(modelState), label: t("settings.step.models"), target: null, detail: modelState ? modelCount + t("ui.settings.modelsAdded") : t("ui.settings.modelConfigurationNotLoaded") },
    { done: hasDefaultModel, known: Boolean(modelState), label: t("settings.step.default"), target: "default-chat-model", detail: hasDefaultModel ? libraryModel(modelState!, "chat", modelState!.chat.model)!.name : modelState ? t("ui.settings.noGlobalDefaultModelSavedYet") : t("ui.settings.modelConfigurationNotLoaded") },
  ] : [];

  return (
    <>
      <PageHeader level={2} title={t("ui.settings.servicesModels")} />

      {!windowDesktop && <p role="status" className="text-sm text-muted-foreground">{t("settings.error.desktopOnly")}</p>}
      <Reveal className="-mt-7">{error ? <Alert variant="destructive" className="mt-7"><AlertTitle>{t("settings.error.title")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}</Reveal>
      <Reveal className="-mt-7">{notice ? <Alert className="mt-7"><CheckCircle2 aria-hidden="true" className="size-4" /><AlertTitle>{t("settings.notice.title")}</AlertTitle><AlertDescription>{localizeMessage(notice)}</AlertDescription></Alert> : null}</Reveal>

      <div className="settings-panel flex flex-col">
          {settings && (
            <ol className="settings-readiness" aria-label={t("settings.readinessLabel")}>
              {steps.map((step, index) => {
                const content = <>
                  {step.done ? <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-success" /> : <span aria-hidden="true" className="settings-step-number">{step.known ? index + 1 : "—"}</span>}
                  <span className="min-w-0"><span className="block text-sm font-medium">{step.label}<span className="sr-only">{step.known ? step.done ? t("ui.settings.complete") : t("ui.settings.incomplete") : t("ui.settings.statusUnknown")}</span></span><span className="block truncate text-xs text-muted-foreground" title={step.detail}>{step.detail}</span></span>
                </>;
                return (
                  <li key={step.label} data-complete={step.known ? step.done : "unknown"}>
                    {step.target
                      ? <a href={`#${step.target}`} className="settings-readiness-link" onClick={event => { event.preventDefault(); scrollToPart(step.target!); }}>{content}</a>
                      : <SettingsLink section="models" className="settings-readiness-link">{content}</SettingsLink>}
                  </li>
                );
              })}
            </ol>
          )}
          <SettingsSection id="service-keys" title={t("settings.serviceTitle")} description={t("ui.settings.configureModelServiceKeysKeysAre")}>
              {isLoading && !settings ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin" />{t("settings.loading")}</p> : (
                <form className="flex flex-col gap-5" onSubmit={onSubmit}>
                  <FieldGroup className="settings-fields gap-0">
                    {[
                      { id: "openrouter-key", label: "OpenRouter API Key", value: openrouterApiKey, onChange: setOpenrouterApiKey, configured: settings?.hasOpenrouterApiKey, clear: clearOpenrouterApiKey, onClear: setClearOpenrouterApiKey, clearLabel: t("settings.clearOpenrouter"), placeholder: "sk-or-v1-…", hint: t("ui.settings.chatImageAndVideoGeneration") },
                      { id: "deepseek-key", label: "DeepSeek API Key", value: deepseekApiKey, onChange: setDeepseekApiKey, configured: settings?.hasDeepseekApiKey, clear: clearDeepseekApiKey, onClear: setClearDeepseekApiKey, clearLabel: t("settings.clearDeepseek"), placeholder: t("settings.deepseekPlaceholder"), hint: t("ui.settings.chatOnly") },
                      { id: "tavily-key", label: "Tavily API Key", value: tavilyApiKey, onChange: setTavilyApiKey, configured: settings?.hasTavilyApiKey, clear: clearTavilyApiKey, onClear: setClearTavilyApiKey, clearLabel: t("settings.clearTavily"), placeholder: t("settings.tavilyPlaceholder"), hint: t("ui.settings.backupSearchDoesNotAffectProvider") },
                    ].map(field => (
                      <Field key={field.id} orientation="horizontal" className="settings-field" data-disabled={!settings?.encryptionAvailable || field.clear}>
                        <FieldContent><FieldLabel htmlFor={field.id}>{field.label}</FieldLabel><FieldDescription>{field.hint}</FieldDescription></FieldContent>
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <div className="flex items-center gap-3"><Input id={field.id} autoComplete="off" disabled={!settings?.encryptionAvailable || field.clear} onChange={event => field.onChange(event.target.value)} placeholder={field.placeholder} type="password" value={field.value} /><Status tone={field.configured ? "success" : "neutral"}>{field.configured ? t("settings.configured") : t("settings.notConfigured")}</Status></div>
                          {field.configured && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input checked={field.clear} onChange={event => field.onClear(event.target.checked)} type="checkbox" />{field.clearLabel}</label>}
                        </div>
                      </Field>
                    ))}
                  </FieldGroup>
                  <details className="settings-disclosure">
                    <summary className="settings-disclosure-trigger">{t("ui.settings.connectionSiteOptions")}<span className="ml-auto text-xs text-muted-foreground">{t("ui.settings.proxyOpenRouter")}</span><ChevronDown aria-hidden="true" className="size-4" /></summary>
                    <FieldGroup className="gap-4 pt-4">
                      {[
                        { id: "outbound-proxy", label: t("settings.proxyLabel"), value: outboundProxyUrl, onChange: setOutboundProxyUrl, placeholder: t("settings.proxyPlaceholder") },
                        { id: "site-name", label: t("settings.siteNameLabel"), value: openrouterSiteName, onChange: setOpenrouterSiteName, placeholder: "RiA Desktop" },
                        { id: "http-referrer", label: "OpenRouter HTTP Referrer", value: openrouterHttpReferer, onChange: setOpenrouterHttpReferer, placeholder: t("settings.refererPlaceholder") },
                      ].map(field => <Field key={field.id} orientation="horizontal" className="settings-field"><FieldContent><FieldLabel htmlFor={field.id}>{field.label}</FieldLabel></FieldContent><Input className="min-w-0 flex-1" id={field.id} onChange={event => field.onChange(event.target.value)} placeholder={field.placeholder} value={field.value} /></Field>)}
                    </FieldGroup>
                  </details>
                  {!settings?.encryptionAvailable && <Alert variant="destructive"><AlertTitle>{t("settings.encryptionUnavailableTitle")}</AlertTitle><AlertDescription>{t("settings.encryptionUnavailableBody")}</AlertDescription></Alert>}
                  <div className="flex justify-end"><Button disabled={isSaving || !settings?.encryptionAvailable} type="submit" size="sm">{isSaving && <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" />}{t("settings.saveAndRestart")}</Button></div>
                </form>
              )}
          </SettingsSection>

          <SettingsSection id="default-chat-model" title={t("ui.settings.defaultChatModel")} description={t("ui.settings.newConversationsUseThisModelThe")}>
            <div className="flex flex-col gap-3">
              <Reveal className="-mt-3">{modelError ? <Alert variant="destructive" className="mt-3"><AlertTitle>{t("ui.settings.modelConfigurationNotUpdated")}</AlertTitle><AlertDescription>{localizeMessage(modelError)}</AlertDescription></Alert> : null}</Reveal>
              <div className="flex flex-wrap items-center gap-3">
                <SelectField aria-label={t("ui.settings.defaultChatModel")} className="min-w-0 flex-1 sm:min-w-48" value={defaultModel} disabled={!modelState || savingModel} onValueChange={setDefaultModel}>
                  <SelectOption value="">{t("ui.settings.noDefaultModel")}</SelectOption>
                  {modelState?.library.filter(model => model.modes.includes("chat")).map(model => <SelectOption key={modelRefKey(model)} value={modelRefKey(model)}>{model.name} · {model.providerId}</SelectOption>)}
                </SelectField>
                <Button size="sm" disabled={!modelState || savingModel || defaultModel === savedDefault} onClick={() => void saveDefaultModel()}>{savingModel && <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" />}{t("ui.settings.saveDefaultModel")}</Button>
              </div>
              <div className="flex flex-wrap gap-4 text-xs"><SettingsLink className="text-muted-foreground hover:text-foreground" section="models" anchor="model-preferences">{t("ui.settings.manageDefaultsAndFallbacksForEach")}</SettingsLink><SettingsLink className="text-muted-foreground hover:text-foreground" section="backups">{t("settings.navBackups")}</SettingsLink></div>
            </div>
          </SettingsSection>

          <details className="settings-disclosure px-1">
            <summary className="settings-disclosure-trigger"><ShieldCheck aria-hidden="true" className="size-4" />{t("ui.settings.localSecurityRuntimeInformation")}<ChevronDown aria-hidden="true" className="ml-auto size-4" /></summary>
            <div className="grid gap-5 pb-2 pt-4 sm:grid-cols-2">
              <section className="flex flex-col gap-2 text-xs text-muted-foreground" aria-label={t("settings.securityTitle")}><h2 className="text-sm font-medium text-foreground">{t("settings.securityTitle")}</h2><p>{t("settings.securityKey")}</p><p>{t("settings.securityNoPlaintext")}</p><p>{t("settings.securityLocalApi")}</p></section>
              <section className="flex flex-col gap-2 break-all text-xs text-muted-foreground" aria-label={t("settings.runtimeTitle")}><h2 className="text-sm font-medium text-foreground">{t("settings.runtimeTitle")}</h2><p>{t("settings.runtimeVersion")}{runtime?.appVersion || "—"} · {runtime?.packaged ? t("settings.runtimePackaged") : t("settings.runtimeDev")}</p><p>{t("settings.runtimeDataDirectory")}{runtime?.dataDirectory || "—"}</p><p>{t("settings.runtimeMediaDirectory")}{runtime?.mediaDirectory || "—"}</p><p>{t("settings.runtimeLogFile")}{runtime?.logFile || "—"}</p><SettingsLink className="text-foreground underline underline-offset-4" section="storage">{t("settings.manageStorage")}</SettingsLink></section>
            </div>
          </details>
      </div>
    </>
  );
}
