"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, KeyRound, Loader2, MonitorCog, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

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
        setError("桌面设置只能在安装版或 Electron 开发模式中使用。");
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
          setNotice("设置已保存，本地 AI 服务已使用新配置重新启动。");
        } else if (window.location.search.includes("welcome=1")) {
          setNotice("首次使用请配置 OpenRouter API Key。密钥只会以系统加密形式保存在本机。");
        }
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "读取桌面设置失败。"))
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
      setNotice("设置已加密保存，正在重启本地 AI 服务……");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存桌面设置失败。");
      setIsSaving(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 p-4 md:p-6">
      <header>
        <Link
          className="mb-3 inline-flex h-8 items-center rounded-md bg-muted px-3 text-xs font-medium text-foreground transition hover:bg-muted/80"
          href="/chat"
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          返回聊天
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <MonitorCog className="h-5 w-5 text-primary" />
          桌面设置
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">管理模型服务密钥、代理和本地运行信息。</p>
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>设置不可用</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>桌面配置</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="glass-surface">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              服务配置
            </CardTitle>
            <CardDescription>密钥输入框不会回显已保存的内容；留空表示保留原密钥。</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在读取设置…
              </div>
            ) : (
              <form className="space-y-5" onSubmit={onSubmit}>
                <label className="block space-y-2 text-sm">
                  <span className="flex items-center justify-between font-medium">
                    OpenRouter API Key
                    <Badge variant={settings?.hasOpenrouterApiKey ? "success" : "outline"}>
                      {settings?.hasOpenrouterApiKey ? "已配置" : "未配置"}
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
                      删除已保存的 OpenRouter 密钥
                    </span>
                  ) : null}
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="flex items-center justify-between font-medium">
                    Tavily API Key
                    <Badge variant={settings?.hasTavilyApiKey ? "success" : "outline"}>
                      {settings?.hasTavilyApiKey ? "已配置" : "未配置"}
                    </Badge>
                  </span>
                  <Input
                    autoComplete="off"
                    disabled={!settings?.encryptionAvailable || clearTavilyApiKey}
                    onChange={(event) => setTavilyApiKey(event.target.value)}
                    placeholder="tvly-…（联网搜索可选）"
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
                      删除已保存的 Tavily 密钥
                    </span>
                  ) : null}
                </label>

                <label className="block space-y-2 text-sm">
                  <span className="font-medium">出站代理 URL</span>
                  <Input
                    onChange={(event) => setOutboundProxyUrl(event.target.value)}
                    placeholder="http://127.0.0.1:7897（可选）"
                    value={outboundProxyUrl}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">OpenRouter 站点名称</span>
                  <Input
                    onChange={(event) => setOpenrouterSiteName(event.target.value)}
                    placeholder="Private AI Assistant Desktop"
                    value={openrouterSiteName}
                  />
                </label>
                <label className="block space-y-2 text-sm">
                  <span className="font-medium">OpenRouter HTTP Referrer</span>
                  <Input
                    onChange={(event) => setOpenrouterHttpReferer(event.target.value)}
                    placeholder="https://example.com（可选）"
                    value={openrouterHttpReferer}
                  />
                </label>

                {!settings?.encryptionAvailable ? (
                  <Alert variant="destructive">
                    <AlertTitle>系统加密不可用</AlertTitle>
                    <AlertDescription>为避免明文落盘，当前环境禁止保存 API Key。</AlertDescription>
                  </Alert>
                ) : null}

                <Button disabled={isSaving || !settings?.encryptionAvailable} type="submit">
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  保存并重启本地服务
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="glass-surface">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" />
                本地安全
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>API Key 使用 Windows 系统加密后再写入配置文件。</p>
              <p>网页渲染进程只能看到“是否已配置”，不能读取密钥明文。</p>
              <p>本地 API 受随机会话 Cookie 与 Host 校验保护。</p>
            </CardContent>
          </Card>
          <Card className="glass-surface">
            <CardHeader>
              <CardTitle className="text-base">运行信息</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 break-all text-xs text-muted-foreground">
              <p>版本：{runtime?.appVersion || "—"}</p>
              <p>模式：{runtime?.packaged ? "安装版" : "开发版"}</p>
              <p>数据目录：{runtime?.dataDirectory || "—"}</p>
              <p>媒体目录：{runtime?.mediaDirectory || "—"}</p>
              <Link className="inline-block underline" href="/storage">管理媒体存储</Link>
              <p>日志：{runtime?.logFile || "—"}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}
