"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { AssistantSnapshot } from "@/lib/assistants/schema";

export function TemplateDetails({ snapshot }: { snapshot: AssistantSnapshot }) {
  return (
    <Sheet>
      <SheetTrigger asChild><Button size="sm" variant="ghost">模板详情</Button></SheetTrigger>
      <SheetContent side="right" className="template-details-sheet flex flex-col gap-5 overflow-y-auto p-5 sm:p-6">
        <header className="flex flex-col gap-2 pr-8">
          <SheetTitle className="break-words text-lg font-semibold">模板详情 · {snapshot.name}</SheetTitle>
          <SheetDescription>当前会话使用的模板配置，修改原模板不会自动同步。</SheetDescription>
        </header>
        {snapshot.description ? <p className="break-words text-sm leading-6 text-muted-foreground">{snapshot.description}</p> : null}
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex flex-col items-start gap-1.5">
            <dt className="text-xs text-muted-foreground">快照版本</dt>
            <dd><Badge variant="outline">v{snapshot.templateRevision}</Badge></dd>
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <dt className="text-xs text-muted-foreground">允许的工具</dt>
            <dd><Badge variant="outline">{snapshot.tools.length} 个工具</Badge></dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs text-muted-foreground">模板记忆策略</dt>
            <dd>{snapshot.usesMemory ? "开启" : "关闭"}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <dt className="text-xs text-muted-foreground">聊天模型</dt>
            <dd className="break-words [overflow-wrap:anywhere]">{snapshot.model ? `${snapshot.model.providerId} / ${snapshot.model.modelId}` : "跟随会话选择"}</dd>
          </div>
          <div className="col-span-2 flex min-w-0 flex-col gap-1.5">
            <dt className="text-xs text-muted-foreground">模板知识范围</dt>
            <dd className="break-words">{snapshot.collections.length ? snapshot.collections.join("、") : "全部知识集合"}</dd>
          </div>
        </dl>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">助理指令</h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground [overflow-wrap:anywhere]">{snapshot.instructions}</p>
        </section>
      </SheetContent>
    </Sheet>
  );
}
