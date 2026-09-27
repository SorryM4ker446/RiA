import Link from "next/link";
import { ArrowRight, MessageSquare, Sparkles, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/locale";

const FEATURES = [
  { icon: MessageSquare, title: t("home.feature.chat.title"), body: t("home.feature.chat.body") },
  { icon: Sparkles, title: t("home.feature.memory.title"), body: t("home.feature.memory.body") },
  { icon: Workflow, title: t("home.feature.tools.title"), body: t("home.feature.tools.body") },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center gap-6 px-6 py-16 md:px-10">
      <section className="animate-panel-in-up rounded-xl bg-card p-5 shadow-card md:p-6">
        <div className="space-y-2">
          {/* The wordmark IS the hero. A logo tile above a headline read as a
              placeholder avatar, and a second small "RiA" eyebrow repeated the
              name at a weight the page did not need. */}
          <p className="font-mono text-5xl font-semibold leading-none tracking-display text-foreground md:text-6xl">
            {t("brand.name")}
          </p>
          {/* text-balance keeps the CJK headline from leaving a stranded final
              line; text-pretty does the same for the paragraph below. */}
          <h1 className="text-balance pt-2 text-3xl font-semibold leading-tight tracking-headline md:text-4xl">
            {t("home.title")}
          </h1>
          <p className="text-pretty text-sm leading-6 text-muted-foreground">
            {t("home.description")}
          </p>
        </div>
      </section>

      <div
        className="animate-row-in flex flex-wrap items-center gap-3"
        style={{ animationDelay: "60ms" }}
      >
        <Link href="/chat">
          <Button size="lg">
            {t("home.primaryAction")} <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Link>
        <a href="https://sdk.vercel.ai/docs" rel="noreferrer" target="_blank">
          <Button size="lg" variant="outline">
            {t("home.secondaryAction")}
          </Button>
        </a>
      </div>

      <section className="grid gap-3 md:grid-cols-3">
        {FEATURES.map((feature) => (
          // The enter keyframes fill backwards, so a row without its own delay
          // sits at opacity 0 until the animation resolves and the grid then
          // lands as one flat block. Per-row delay is what reads as a stagger.
          <Card
            className="animate-row-in bg-elevated transition-[box-shadow,transform] duration-[--dur-base] ease-[--ease-out] hover:-translate-y-px hover:shadow-raised"
            key={feature.title}
            style={{ animationDelay: `${120 + FEATURES.indexOf(feature) * 60}ms` }}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 tracking-title">
                <feature.icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                {feature.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-pretty text-[13px] leading-5 text-muted-foreground">
              {feature.body}
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
