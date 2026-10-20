"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DirectoryGrantSettings } from "@/features/settings/directory-grants";

export function DirectoryPermissions({ onChange }: { onChange: () => void }) {
  useLocale();
  return <Sheet>
    <SheetTrigger asChild>
      <Button size="sm" variant="ghost" aria-label={t("ui.settings.filePermissions")} title={t("ui.chat.directory-permissions.manageFileAccessAndTerminalPermissions")}>
        <FolderOpen aria-hidden="true" data-icon="inline-start" />{t("ui.settings.filePermissions")}</Button>
    </SheetTrigger>
    <SheetContent side="right" className="directory-permissions-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel={t("ui.chat.directory-permissions.closeFilePermissions")}>
      <header className="flex flex-col gap-2 pr-7">
        <SheetTitle>{t("ui.settings.filePermissions")}</SheetTitle>
        <SheetDescription>{t("ui.chat.directory-permissions.manageLocalDirectoriesAvailableToAll")}</SheetDescription>
      </header>
      <div className="chat-list-scroll min-h-0 flex-1 overflow-y-auto">
        <DirectoryGrantSettings embedded onChange={onChange} />
      </div>
    </SheetContent>
  </Sheet>;
}
