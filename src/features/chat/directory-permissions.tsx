"use client";

import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DirectoryGrantSettings } from "@/features/settings/directory-grants";

export function DirectoryPermissions({ onChange }: { onChange: () => void }) {
  return <Sheet>
    <SheetTrigger asChild>
      <Button size="sm" variant="ghost" aria-label="文件权限" title="管理文件访问和终端权限">
        <FolderOpen aria-hidden="true" data-icon="inline-start" />文件权限
      </Button>
    </SheetTrigger>
    <SheetContent side="right" className="directory-permissions-sheet flex flex-col gap-5 p-5 sm:p-6" closeLabel="关闭文件权限">
      <header className="flex flex-col gap-2 pr-7">
        <SheetTitle>文件权限</SheetTitle>
        <SheetDescription>管理所有会话可用的本地目录。目录授权允许读取文件，终端权限需单独开启，可选择完全访问或逐条审批。</SheetDescription>
      </header>
      <div className="chat-list-scroll min-h-0 flex-1 overflow-y-auto">
        <DirectoryGrantSettings embedded onChange={onChange} />
      </div>
    </SheetContent>
  </Sheet>;
}
