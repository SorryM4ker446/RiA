import Link from "next/link";
import { StoragePanel } from "@/features/media/storage-panel";
import { t } from "@/lib/locale";

export default function StoragePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <header>
        <Link className="text-sm text-muted-foreground transition-colors hover:text-foreground" href="/chat">
          {t("storage.backToChat")}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-headline">{t("storage.title")}</h1>
      </header>
      <StoragePanel />
    </main>
  );
}
