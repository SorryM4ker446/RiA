"use client";

import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The "?" beside a heading: explanations a page needs only now and then
 * (what is kept, what is left out, where something comes from) wait here
 * instead of standing in the page as a paragraph.
 */
export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  return <TooltipProvider delayDuration={300}><Tooltip>
    <TooltipTrigger asChild><Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={label}><CircleHelp aria-hidden="true" /></Button></TooltipTrigger>
    <TooltipContent side="bottom" align="end" className="max-w-xs text-xs leading-relaxed">{children}</TooltipContent>
  </Tooltip></TooltipProvider>;
}
