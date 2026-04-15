import Link from "next/link";
import { ArrowRight, MessageSquare, Sparkles, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-8 p-6 md:p-10">
      <div className="space-y-4">
        <Badge className="w-fit" variant="secondary">
          Private AI Assistant MVP
        </Badge>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">
          Build your personal assistant with chat, memory, and tool calling.
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground md:text-base">
          Next.js App Router + Vercel AI SDK + PostgreSQL. The core MVP flow is now ready for
          daily usage and future RAG expansion.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Link href="/chat">
          <Button size="lg">
            Open Chat <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
        <a href="https://sdk.vercel.ai/docs" rel="noreferrer" target="_blank">
          <Button size="lg" variant="outline">
            AI SDK Docs
          </Button>
        </a>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <Card className="glass-surface">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-primary" />
              Streaming Chat
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            `useChat` compatible, multi-round context, and persisted conversations.
          </CardContent>
        </Card>
        <Card className="glass-surface">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Memory Ready
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Short-term context + long-term memory retrieval injected before generation.
          </CardContent>
        </Card>
        <Card className="glass-surface">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Workflow className="h-4 w-4 text-primary" />
              Tool Calling
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Registered tools with typed schemas and UI-visible execution states.
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
