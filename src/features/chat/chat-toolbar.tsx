import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  OPENROUTER_IMAGE_MODELS,
  OPENROUTER_MODELS,
  OPENROUTER_VIDEO_MODELS
} from "@/config/model";
import {
  imagePrompts,
  ModelMode,
  quickPrompts,
  videoPrompts
} from "@/features/chat/page-utils";
import { Sparkles } from "lucide-react";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "activeChat" | "isPending" | "modelMode" | "selectedModel" | "selectedModelInfo" | "onModeSelect" | "onModelSelect" | "appendQuickPrompt">;
export function ChatToolbar({ activeChat, isPending, modelMode, selectedModel, selectedModelInfo, onModeSelect, onModelSelect, appendQuickPrompt }: Props) {
  return (<CardHeader className="space-y-3 border-b border-border/70 pb-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          {activeChat?.title ?? "新会话"}
        </CardTitle>
        <CardDescription>
          {isPending
            ? modelMode === "image"
              ? "正在生成图片..."
              : modelMode === "video"
                ? "正在生成视频..."
                : "助手正在思考..."
            : modelMode === "image"
              ? "当前为文生图模式，输入描述后生成图片。"
              : modelMode === "video"
                ? "当前为视频生成模式，输入描述后生成视频。"
                : "你可以持续多轮对话，消息会自动持久化。"}
        </CardDescription>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={isPending ? "warning" : "success"}>
          {isPending ? "生成中" : "就绪"}
        </Badge>
        <Badge variant="outline">
          {modelMode === "chat" ? "聊天模型" : modelMode === "image" ? "图像模型" : "视频模型"}
        </Badge>
        <Badge className="max-w-[220px] truncate" variant="outline">
          {selectedModel}
        </Badge>
      </div>
    </div>
    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_160px_240px] md:items-center">
      <p className="text-xs text-muted-foreground">
        当前模型：{selectedModelInfo?.label ?? selectedModel}
        {selectedModelInfo?.description ? ` · ${selectedModelInfo.description}` : ""}
      </p>
      <Select disabled={isPending} onValueChange={(value) => onModeSelect(value as ModelMode)} value={modelMode}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="chat">聊天模式</SelectItem>
          <SelectItem value="image">文生图模式</SelectItem>
          <SelectItem value="video">视频生成模式</SelectItem>
        </SelectContent>
      </Select>
      <Select disabled={isPending} onValueChange={onModelSelect} value={selectedModel}>
        <SelectTrigger className="min-h-11">
          <SelectValue className="line-clamp-2 whitespace-normal text-[13px]" />
        </SelectTrigger>
        <SelectContent>
          {(
            modelMode === "chat"
              ? OPENROUTER_MODELS
              : modelMode === "image"
                ? OPENROUTER_IMAGE_MODELS
                : OPENROUTER_VIDEO_MODELS
          ).map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex flex-wrap gap-2">
      {(modelMode === "chat"
        ? quickPrompts
        : modelMode === "image"
          ? imagePrompts
          : videoPrompts
      ).map((prompt) => (
        <Button
          className="h-7 px-2.5 text-[11px]"
          key={prompt}
          onClick={() => appendQuickPrompt(prompt)}
          type="button"
          variant="secondary"
        >
          {prompt}
        </Button>
      ))}
    </div>
  </CardHeader>);
}

