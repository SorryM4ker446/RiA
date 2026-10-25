import type { ReactNode } from "react";

/**
 * The top of every workspace page: the title,
 * one line on what the page is for, and the page's actions on the right. A page
 * keeps a single solid action here; anything else is a quiet icon or ghost
 * button, so the eye lands on the title first. A section of the settings
 * overlay uses the same header one level down, under the overlay's own title.
 */
export function PageHeader({ title, description, actions, level = 1 }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; level?: 1 | 2 }) {
  const Heading = level === 1 ? "h1" : "h2";
  return <header className="workspace-page-header">
    <div className="flex min-w-0 flex-col gap-2">
      <Heading className="flex items-center gap-2 break-words">{title}</Heading>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
  </header>;
}
