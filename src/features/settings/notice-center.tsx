"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/locale";

type Notice = {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  href: string | null;
  createdAt: string;
  readAt: string | null;
};

/**
 * What the app wanted to tell you, kept where it can still be found.
 *
 * A system notification can be refused, suppressed, or missed, so it is not
 * treated as the record — this is. A notice that repeats updates the row it
 * already has rather than stacking a new one every morning, so an outstanding
 * reminder stays one item until it is dealt with.
 */
export function NoticeCenter({ onCountChange }: { onCountChange?: (unread: number) => void }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notices?includeRead=true", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const rows: Notice[] = payload.data.notices ?? [];
      setNotices(rows);
      onCountChange?.(payload.data.unread ?? 0);
    } catch {
      // A reminder centre that cannot load must not take the page with it; the
      // rest of the app is unaffected by it being empty.
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { void load(); }, [load]);

  async function send(method: "PATCH" | "DELETE" | "POST", path: string) {
    await fetch(path, { method, headers: { "Content-Type": "application/json" } }).catch(() => 0);
    await load();
  }

  const unread = notices.filter((notice) => !notice.readAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          {t("notices.title")}
          {unread.length > 0 ? (
            <span className="rounded-full bg-destructive px-1.5 text-[10px] text-destructive-foreground">{unread.length}</span>
          ) : null}
        </CardTitle>
        <CardDescription>{t("notices.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("notices.loading")}
          </p>
        ) : notices.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("notices.empty")}</p>
        ) : (
          <>
            <ul className="space-y-2">
              {notices.slice(0, 20).map((notice) => (
                <li
                  className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 ${notice.readAt ? "border-border opacity-70" : "border-border bg-muted/40"}`}
                  key={notice.id}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t(`notices.title_${notice.title}` as never)}</p>
                    {notice.detail ? <p className="truncate text-xs text-muted-foreground">{notice.detail}</p> : null}
                    <p className="text-[11px] text-muted-foreground">{new Date(notice.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {notice.href ? (
                      <Link
                        className="text-xs underline underline-offset-2"
                        href={notice.href}
                        onClick={() => void send("PATCH", `/api/notices/${encodeURIComponent(notice.id)}`)}
                      >
                        {t("notices.open")}
                      </Link>
                    ) : null}
                    <Button
                      aria-label={t("notices.dismiss")}
                      onClick={() => void send("DELETE", `/api/notices/${encodeURIComponent(notice.id)}`)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {unread.length > 0 ? (
              <Button onClick={() => void send("POST", "/api/notices")} size="sm" type="button" variant="outline">
                <CheckCheck aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                {t("notices.markAllRead")}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
