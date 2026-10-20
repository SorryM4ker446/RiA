"use client";
import { useLocale } from "@/lib/locale/client";
import Link from "next/link";
import { StoragePanel } from "@/features/media/storage-panel";
import { t } from "@/lib/locale";

export default function StoragePage() {
  useLocale();
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-7">
      <header className="workspace-page-header flex-col !items-start">
        <Link className="text-sm text-muted-foreground transition-colors hover:text-foreground" href="/chat">
          {t("storage.backToChat")}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-headline">{t("storage.title")}</h1>
      </header>
      <StoragePanel />
    </main>
  );
}
