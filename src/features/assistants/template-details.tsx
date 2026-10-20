"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { AssistantSnapshot } from "@/lib/assistants/schema";

export function TemplateDetails({ snapshot }: { snapshot: AssistantSnapshot }) {
  useLocale();
  return (
    <Sheet>
      <SheetTrigger asChild><Button size="sm" variant="ghost">{t("ui.assistants.template-details.templateDetails")}</Button></SheetTrigger>
      <SheetContent side="right" className="template-details-sheet flex flex-col gap-5 overflow-y-auto p-5 sm:p-6">
        <header className="flex flex-col gap-2 pr-8">
          <SheetTitle className="break-words text-lg font-semibold">{tf("ui.assistants.template-details.templateDetails2", { name: snapshot.templateId.startsWith("builtin_") ? localizeMessage(snapshot.name) : snapshot.name })}</SheetTitle>
          <SheetDescription>{t("ui.assistants.template-details.templateConfigurationUsedByThisConversation")}</SheetDescription>
        </header>
        {snapshot.description ? <p className="break-words text-sm leading-6 text-muted-foreground">{snapshot.templateId.startsWith("builtin_") ? localizeMessage(snapshot.description) : snapshot.description}</p> : null}
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex flex-col items-start gap-1.5">
            <dt className="text-xs text-muted-foreground">{t("ui.assistants.template-details.snapshotVersion")}</dt>
            <dd><Badge variant="outline">v{snapshot.templateRevision}</Badge></dd>
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <dt className="text-xs text-muted-foreground">{t("ui.assistants.template-details.allowedTools")}</dt>
            <dd><Badge variant="outline">{snapshot.tools.length} {t("ui.assistants.template-details.tools")}</Badge></dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs text-muted-foreground">{t("ui.assistants.template-details.templateMemoryPolicy")}</dt>
            <dd>{snapshot.usesMemory ? t("ui.assistants.template-details.on") : t("ui.common.off")}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <dt className="text-xs text-muted-foreground">{t("chat.toolbar.kindChat")}</dt>
            <dd className="break-words [overflow-wrap:anywhere]">{snapshot.model ? `${snapshot.model.providerId} / ${snapshot.model.modelId}` : t("ui.assistants.template-details.followConversationSetting")}</dd>
          </div>
          <div className="col-span-2 flex min-w-0 flex-col gap-1.5">
            <dt className="text-xs text-muted-foreground">{t("ui.assistants.template-details.templateKnowledgeScope")}</dt>
            <dd className="break-words">{snapshot.collections.length ? snapshot.collections.join("、") : t("ui.assistants.allKnowledgeCollections")}</dd>
          </div>
        </dl>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t("ui.assistants.template-details.assistantInstructions")}</h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground [overflow-wrap:anywhere]">{snapshot.instructions}</p>
        </section>
      </SheetContent>
    </Sheet>
  );
}
