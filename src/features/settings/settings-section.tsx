import type { ComponentProps, ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/** A shared, flat section for settings, with the same hierarchy in every tab. */
export function SettingsSection({ title, description, action, children, className, ...props }: Omit<ComponentProps<typeof Card>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return <Card {...props} className={cn("settings-section", className)}>
    <CardHeader className="p-0 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="flex items-center gap-2">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </div>
    </CardHeader>
    <CardContent className="p-0">{children}</CardContent>
  </Card>;
}

export function SettingsHelp({ title, children }: { title: string; children: ReactNode }) {
  return <details className="settings-disclosure settings-help">
    <summary className="settings-disclosure-trigger">{title}<ChevronDown aria-hidden="true" className="ml-auto size-4" /></summary>
    <div className="flex flex-col gap-2 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground">{children}</div>
  </details>;
}
