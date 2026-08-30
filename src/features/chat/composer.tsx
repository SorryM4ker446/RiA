import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { chatModelSupportsImageInput } from "@/config/model";
import { IMAGE_MEDIA_TYPES } from "@/lib/media/limits";
import { cn } from "@/lib/utils/cn";
import {
  Loader2,
  SendHorizonal
} from "lucide-react";
import { getManualToolFieldError } from "@/features/chat/tool-input";
import type { ManualToolSelection } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";

type Props = Pick<ChatState, "onSubmit" | "modelMode" | "isPending" | "setSelectedManualTool" | "manualToolSelectValue" | "manualTools" | "manualToolsOnly" | "setManualToolsOnly" | "selectedManualToolConfig" | "manualToolFieldValues" | "setManualToolFieldValues" | "manualToolFieldErrors" | "setManualToolFieldErrors" | "toolCatalogError" | "setInput" | "handleTextareaKeyDown" | "onTextareaPaste" | "textareaRef" | "input" | "isManualToolSelected" | "onAttachmentInputChange" | "fileInputRef" | "attachments" | "clearAttachments" | "attachmentNames" | "selectedImageModel" | "selectedVideoModel" | "selectedManualTool" | "selectedChatModel" | "activeChat">;
export function Composer({ onSubmit, modelMode, isPending, setSelectedManualTool, manualToolSelectValue, manualTools, manualToolsOnly, setManualToolsOnly, selectedManualToolConfig, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors, setManualToolFieldErrors, toolCatalogError, setInput, handleTextareaKeyDown, onTextareaPaste, textareaRef, input, isManualToolSelected, onAttachmentInputChange, fileInputRef, attachments, clearAttachments, attachmentNames, selectedImageModel, selectedVideoModel, selectedManualTool, selectedChatModel, activeChat }: Props) {
  return (<form className="space-y-3" noValidate onSubmit={onSubmit}>
    {modelMode === "chat" ? (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">工具</Badge>
          <Select
            disabled={isPending}
            onValueChange={(value) => setSelectedManualTool(value as ManualToolSelection)}
            value={manualToolSelectValue}
          >
            <SelectTrigger
              aria-label="选择手动工具"
              className="h-7 w-[210px] border-dashed bg-transparent text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">自动（按语义触发）</SelectItem>
              {manualTools.map((tool) => (
                <SelectItem key={tool.id} value={tool.id}>
                  {tool.manual.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="inline-flex items-center gap-1.5">
            <input
              checked={manualToolsOnly}
              className="h-3.5 w-3.5"
              disabled={isPending}
              onChange={(event) => setManualToolsOnly(event.target.checked)}
              type="checkbox"
            />
            <span>仅手动</span>
          </label>
        </div>

        {selectedManualToolConfig && selectedManualToolConfig.manual.fields.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-3">
            {selectedManualToolConfig.manual.fields.map((field) => {
              const value = manualToolFieldValues[field.key] ?? "";
              if (field.type === "select") {
                return (
                  <Select
                    key={field.key}
                    onValueChange={(nextValue) =>
                      setManualToolFieldValues((prev) => ({
                        ...prev,
                        [field.key]: nextValue,
                      }))
                    }
                    value={value || field.defaultValue || ""}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue placeholder={field.label} />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((option) => (
                        <SelectItem key={`${field.key}-${option.value}`} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              }

              const error = manualToolFieldErrors[field.key];
              const fieldErrorId = `manual-tool-${field.key}-error`;
              return (
                <div className="space-y-1.5" key={field.key}>
                  <Input
                    aria-describedby={error ? fieldErrorId : undefined}
                    aria-invalid={error ? true : undefined}
                    className={cn(
                      "h-8",
                      error
                        ? "border-destructive/60 bg-background text-foreground focus-visible:border-destructive focus-visible:ring-destructive/20"
                        : "",
                    )}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setManualToolFieldValues((prev) => ({
                        ...prev,
                        [field.key]: nextValue,
                      }));
                      setManualToolFieldErrors((prev) => {
                        const nextError = getManualToolFieldError(field, nextValue);
                        if (nextError) {
                          return { ...prev, [field.key]: nextError };
                        }
                        const rest = { ...prev };
                        delete rest[field.key];
                        return rest;
                      });
                    }}
                    placeholder={field.placeholder ?? field.label}
                    type={field.type === "number" ? "text" : field.type}
                    value={value}
                  />
                  {error ? (
                    <p
                      className="px-1 text-[11px] leading-4 text-destructive/90"
                      id={fieldErrorId}
                      role="alert"
                    >
                      <span>{error}</span>
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {toolCatalogError ? (
          <p className="text-[11px] text-amber-500">工具目录加载失败：{toolCatalogError}</p>
        ) : manualTools.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">当前无可手动触发工具，默认按语义自动回答。</p>
        ) : selectedManualToolConfig ? (
          <p className="text-[11px] text-muted-foreground">{selectedManualToolConfig.description}</p>
        ) : null}
      </div>
    ) : null}

    <Textarea
      onChange={(event) => setInput(event.target.value)}
      onKeyDown={handleTextareaKeyDown}
      onPaste={onTextareaPaste}
      placeholder={
        modelMode === "image"
          ? "描述你想生成的图片，或粘贴参考图...（Enter 发送，Shift+Enter 换行）"
          : modelMode === "video"
            ? "描述你想生成的视频，或粘贴参考图...（Enter 发送，Shift+Enter 换行）"
            : selectedManualToolConfig
              ? selectedManualToolConfig.manual.placeholder
              : "输入你的问题，或粘贴图片让模型识别...（Enter 发送，Shift+Enter 换行）"
      }
      ref={textareaRef}
      rows={1}
      value={input}
    />
    <div className="flex flex-wrap items-center gap-2">
      <input
        accept={IMAGE_MEDIA_TYPES.join(",")}
        className="block max-w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-primary/10 file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-primary hover:file:bg-primary/20"
        disabled={isManualToolSelected}
        multiple
        onChange={onAttachmentInputChange}
        ref={fileInputRef}
        type="file"
      />
      {attachments.length > 0 ? (
        <Button onClick={clearAttachments} size="sm" type="button" variant="ghost">
          清空附件（{attachments.length}）
        </Button>
      ) : null}
      <span className="text-[11px] text-muted-foreground">
        {isManualToolSelected
          ? "手动工具模式下已禁用图片附件"
          : "支持 Ctrl/Cmd+V 直接粘贴图片"}
      </span>
      {attachmentNames.length > 0 ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {attachmentNames.join("，")}
        </span>
      ) : null}
    </div>
    <div className="flex items-center justify-between">
      <p className="text-xs text-muted-foreground">
        {modelMode === "image"
          ? `当前模式：文生图 · 选中模型：${selectedImageModel}`
          : modelMode === "video"
            ? `当前模式：视频生成 · 选中模型：${selectedVideoModel}`
            : isManualToolSelected
              ? `当前模式：手动工具触发 · ${selectedManualToolConfig?.id ?? selectedManualTool} · 自动工具调用${manualToolsOnly ? "已禁用" : "已启用"}`
              : !chatModelSupportsImageInput(selectedChatModel)
                ? `当前聊天模型仅支持纯文本：${selectedChatModel}`
                : attachments.length > 0
                  ? `已选择 ${attachments.length} 个图片附件 · 会话将自动保存`
                  : `当前会话：${activeChat?.title ?? "未创建"} · 消息将自动保存`}
      </p>
      <Button
        disabled={
          isPending ||
          (!input.trim() && attachments.length === 0)
        }
        type="submit"
      >
        {isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Thinking...
          </>
        ) : (
          <>
            <SendHorizonal className="mr-2 h-4 w-4" />
            {isManualToolSelected ? selectedManualToolConfig?.manual.submitLabel ?? "执行工具" : "发送"}
          </>
        )}
      </Button>
    </div>
  </form>);
}

