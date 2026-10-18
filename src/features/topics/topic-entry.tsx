import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
export function TopicEntry() {
  return <Button size="sm" variant="ghost" asChild><Link href="/topics">打开知识专题工作区<ArrowUpRight data-icon="inline-end" /></Link></Button>;
}
