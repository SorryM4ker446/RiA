import Link from "next/link";
import { StoragePanel } from "@/features/media/storage-panel";

export default function StoragePage() {
  return <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6 pt-20">
    <div className="flex gap-4"><Link className="text-sm underline" href="/chat">返回聊天</Link><Link className="text-sm underline" href="/media">媒体资源库</Link></div>
    <StoragePanel />
  </main>;
}
