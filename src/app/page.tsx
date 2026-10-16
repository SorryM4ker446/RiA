import Link from "next/link";
import { ArrowRight, BookOpen, CalendarClock, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/locale";

const SHORTCUTS = [
  { href: "/chat", icon: MessageSquare, title: "从对话开始", description: "梳理思路、打磨文字，把复杂问题一步步展开。", action: "开始对话" },
  { href: "/knowledge", icon: BookOpen, title: "让资料为你所用", description: "整理文档与长期记忆，带着自己的知识继续思考。", action: "打开知识库" },
  { href: "/tasks", icon: CalendarClock, title: "给计划留个位置", description: "记录待办、设置提醒，让下一步有条不紊。", action: "查看定时任务" },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-12">
      <section className="flex max-w-2xl flex-col items-start gap-6">
        <h1 className="text-4xl font-semibold leading-tight tracking-headline sm:text-5xl">{t("home.title")}</h1>
        <p className="max-w-xl text-base leading-8 text-muted-foreground">{t("home.description")}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href="/chat">{t("home.primaryAction")}<ArrowRight data-icon="inline-end" aria-hidden="true" /></Link></Button>
          <Button asChild variant="outline" size="lg"><Link href="/knowledge">打开知识库</Link></Button>
        </div>
      </section>
      <section aria-label="工作空间入口" className="grid gap-4 md:grid-cols-3">
        {SHORTCUTS.map(item => (
          <Link href={item.href} key={item.href} className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className="home-shortcut flex h-full flex-col">
              <CardHeader>
                <item.icon aria-hidden="true" className="mb-4 size-5 text-muted-foreground" />
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex items-center justify-between gap-3 pt-3">
                <span className="text-sm font-medium">{item.action}</span><ArrowRight aria-hidden="true" className="shortcut-arrow size-4 text-muted-foreground" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-5 text-xs leading-6 text-muted-foreground">
        <span>会话与资料保存在本地，随时继续你的工作。</span>
        <a className="rounded underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href="https://sdk.vercel.ai/docs" rel="noreferrer" target="_blank">{t("home.secondaryAction")}</a>
      </footer>
    </main>
  );
}
