"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import Link from "next/link";
import { ArrowRight, BookOpen, CalendarClock, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
const SHORTCUTS = () => ([
  { href: "/chat", icon: MessageSquare, title: t("ui..startWithAConversation"), description: t("ui..developIdeasRefineYourWritingAnd"), action: t("home.primaryAction") },
  { href: "/knowledge", icon: BookOpen, title: t("ui..putYourKnowledgeToWork"), description: t("ui..organizeDocumentsAndLongTermMemories"), action: t("ui..openKnowledge") },
  { href: "/tasks", icon: CalendarClock, title: t("ui..makeRoomForYourPlans"), description: t("ui..captureTasksAndSetRemindersTo"), action: t("ui..viewScheduledTasks") },
] as const);

export default function HomePage() {
  useLocale();
  return (
    <main className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-12">
      <section className="flex max-w-2xl flex-col items-start gap-6">
        <h1 className="text-4xl font-semibold leading-tight tracking-headline sm:text-5xl">{t("home.title")}</h1>
        <p className="max-w-xl text-base leading-8 text-muted-foreground">{t("home.description")}</p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg"><Link href="/chat">{t("home.primaryAction")}<ArrowRight data-icon="inline-end" aria-hidden="true" /></Link></Button>
          <Button asChild variant="outline" size="lg"><Link href="/knowledge">{t("ui..openKnowledge")}</Link></Button>
        </div>
      </section>
      <section aria-label={t("ui..workspaceShortcuts")} className="grid gap-4 md:grid-cols-3">
        {SHORTCUTS().map(item => (
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
        <span>{t("ui..conversationsAndKnowledgeStayLocalReady")}</span>
      </footer>
    </main>
  );
}
