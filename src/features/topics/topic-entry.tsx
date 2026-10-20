"use client";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
export function TopicEntry() {
  useLocale();
  return <Button size="sm" variant="ghost" asChild><Link href="/topics">{t("ui.topics.topic-entry.openKnowledgeTopicWorkspace")}<ArrowUpRight data-icon="inline-end" /></Link></Button>;
}
