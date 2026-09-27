"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, MonitorCog, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/locale";

export default function DesktopSettingsPage() {
  const [settings, setSettings] = useState<DesktopSettingsView | null>(null);
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [tavilyApiKey, setTavilyApiKey] = useState("");
  const [outboundProxyUrl, setOutboundProxyUrl] = useState("");
  const [openrouterSiteName, setOpenrouterSiteName] = useState("");
  const [openrouterHttpReferer, setOpenrouterHttpReferer] = useState("");
  const [clearOpenrouterApiKey, setClearOpenrouterApiKey] = useState(false);
  const [clearTavilyApiKey, setClearTavilyApiKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.privateAiDesktop;
    if (!bridge) {
      queueMicrotask(() => {
        setError(t("settings.error.desktopOnly"));
        setIsLoading(false);
      });
      return;
    }

    Promise.all([bridge.getSettings(), bridge.getRuntimeInfo()])
      .then(([loadedSettings, loadedRuntime]) => {
        setSettings(loadedSettings);
        setRuntime(loadedRuntime);
        setOutboundProxyUrl(loadedSettings.outboundProxyUrl);
        setOpenrouterSiteName(loadedSettings.openrouterSiteName);
        setOpenrouterHttpReferer(loadedSettings.openrouterHttpReferer);
        if (window.location.search.includes("saved=1")) {
          setNotice(t("settings.notice.saved"));
        } else if (window.location.search.includes("welcome=1")) {
          setNotice(t("settings.notice.welcome"));
        }
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : t("settings.error.load")))
      .finally(() => setIsLoading(false));
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bridge = window.privateAiDesktop;
    if (!bridge) return;

    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await bridge.saveSettings({
        openrouterApiKey,
        tavilyApiKey,
        clearOpenrouterApiKey,
        clearTavilyApiKey,
        outboundProxyUrl,
        openrouterSiteName,
        openrouterHttpReferer,
      });
      setSettings(result.settings);
      setOpenrouterApiKey("");
      setTavilyApiKey("");
      setClearOpenrouterApiKey(false);
      setClearTavilyApiKey(false);
      setNotice(t("settings.notice.saving"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.error.save"));
      setIsSaving(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-6">
      <header>
        <Link
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          href="/chat"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t("settings.backToChat")}
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-headline">
          <MonitorCog aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
          {t("settings.title")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("settings.description")}</p>
      </header>

      <nav className="flex flex-wrap gap-2"><Link href="/models" className="text-sm text-muted-foreground transition-colors hover:text-foreground">{t("settings.navModels")}</Link><span aria-hidden="true" className="text-muted-foreground/40">/</span><Link href="/backups" className="text-sm text-muted-foreground transition-colors hover:text-foreground">{t("settings.navBackups")}</Link></nav>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("settings.error.title")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          <AlertTitle>{t("settings.notice.title")}</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              {t("settings.serviceTitle")}
            </CardTitle>
            <CardDescription>{t("settings.serviceDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Once the settings have been read they stay on screen. Replacing
                the form with a spinner on every re-read meant saving a key made
                the whole panel blink out and back. */}
            {isLoading && !settings ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> {t("settings.loading")}
              </div>
            ) : (
              <form className="space-y-5" onSubmit={onSubmit}>
                <label className="block space-y-2 text-sm">
                  <span className="flex items-center justify-between text-sm font-medium tracking-label">
                    OpenRouter API Key
                    <Badge variant={settings?.hasOpenrouterApiKey ? "success" : "outline"}>
                      {settings?.hasOpenrouterApiKey ? t("settings.configured") : t("settings.notConfigured")}
                    </Badge>
                  </span>
                  <Input
                    autoComplete="off"
                    disabled={!settings?.encryptionAvailable || clearOpenrouterApiKey}
                    onChange={(event) => setOpenrouterApiKey(event.target.value)}
                    placeholder="sk-or-v1-…"
                    type="password"
                    value={openrouterApiKey}
                  />
                  {settings?.hasOpenrouterApiKey ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        checked={clearOpenrouterApiKey}
                        onChange={(event) => setClearOpenrouterApiKey(event.target.checked)}
                        type="checkbox"
                      />
                      {t("settings.clearOpenrouter")}
                    </span>
                  ) : null}
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="flex items-center justify-between text-sm font-medium tracking-label">
                    Tavily API Key
                    <Badge variant={settings?.hasTavilyApiKey ? "success" : "outline"}>
                      {settings?.hasTavilyApiKey ? t("settings.configured") : t("settings.notConfigured")}
                    </Badge>
                  </span>
                  <Input
                    autoComplete="off"
                    disabled={!settings?.encryptionAvailable || clearTavilyApiKey}
                    onChange={(event) => setTavilyApiKey(event.target.value)}
                    placeholder={t("settings.tavilyPlaceholder")}
                    type="password"
                    value={tavilyApiKey}
                  />
                  {settings?.hasTavilyApiKey ? (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        checked={clearTavilyApiKey}
                        onChange={(event) => setClearTavilyApiKey(event.target.checked)}
                        type="checkbox"
                      />
                      {t("settings.clearTavily")}
                    </span>
                  ) : null}
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="text-sm font-medium tracking-label">{t("settings.proxyLabel")}</span>
                  <Input
                    onChange={(event) => setOutboundProxyUrl(event.target.value)}
                    placeholder={t("settings.proxyPlaceholder")}
                    value={outboundProxyUrl}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  <span className="text-sm font-medium tracking-label">{t("settings.siteNameLabel")}</span>
                  <Input
                    onChange={(event) => setOpenrouterSiteName(event.target.value)}
                    placeholder="RiA Desktop"
                    value={openrouterSiteName}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  <span className="text-sm font-medium tracking-label">OpenRouter HTTP Referrer</span>
                  <Input
                    onChange={(event) => setOpenrouterHttpReferer(event.target.value)}
                    placeholder={t("settings.refererPlaceholder")}
                    value={openrouterHttpReferer}
                  />
                </label>

                {!settings?.encryptionAvailable ? (
                  <Alert variant="destructive">
                    <AlertTitle>{t("settings.encryptionUnavailableTitle")}</AlertTitle>
                    <AlertDescription>{t("settings.encryptionUnavailableBody")}</AlertDescription>
                  </Alert>
                ) : null}

                <Button disabled={isSaving || !settings?.encryptionAvailable} type="submit">
                  {isSaving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t("settings.saveAndRestart")}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                {t("settings.securityTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>{t("settings.securityKey")}</p>
              <p>{t("settings.securityNoPlaintext")}</p>
              <p>{t("settings.securityLocalApi")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("settings.runtimeTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 break-all text-xs text-muted-foreground">
              <p>{`${t("settings.runtimeVersion")}${runtime?.appVersion || "—"}`}</p>
              <p>{`${t("settings.runtimeMode")}${runtime?.packaged ? t("settings.runtimePackaged") : t("settings.runtimeDev")}`}</p>
              <p>{`${t("settings.runtimeDataDirectory")}${runtime?.dataDirectory || "—"}`}</p>
              <p>{`${t("settings.runtimeMediaDirectory")}${runtime?.mediaDirectory || "—"}`}</p>
              <Link className="inline-block text-sm text-foreground underline underline-offset-4" href="/storage">{t("settings.manageStorage")}</Link>
              <p>{`${t("settings.runtimeLogFile")}${runtime?.logFile || "—"}`}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
