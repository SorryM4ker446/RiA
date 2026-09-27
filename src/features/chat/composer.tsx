import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t, tf } from "@/lib/locale";
import { IMAGE_MEDIA_TYPES } from "@/lib/media/limits";
import { cn } from "@/lib/utils/cn";
import { Loader2, Paperclip, SendHorizonal } from "lucide-react";
import { getManualToolFieldError } from "@/features/chat/tool-input";
import type { ManualToolSelection } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";
import { ModelMode } from "@/features/chat/page-utils";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";

type Props = Pick<ChatState, "onSubmit" | "modelMode" | "isPending" | "setSelectedManualTool" | "manualToolSelectValue" | "manualTools" | "manualToolsOnly" | "setManualToolsOnly" | "selectedManualToolConfig" | "manualToolFieldValues" | "setManualToolFieldValues" | "manualToolFieldErrors" | "setManualToolFieldErrors" | "toolCatalogError" | "setInput" | "handleTextareaKeyDown" | "onTextareaPaste" | "textareaRef" | "input" | "isManualToolSelected" | "onAttachmentInputChange" | "fileInputRef" | "attachments" | "clearAttachments" | "attachmentNames" | "selectedImageModel" | "selectedVideoModel" | "selectedManualTool" | "selectedChatModel" | "activeChat" | "selectedModelInfo" | "selectedModel" | "onModeSelect" | "onModelSelect" | "modelLibrary">;
export function Composer({ onSubmit, modelMode, isPending, setSelectedManualTool, manualToolSelectValue, manualTools, manualToolsOnly, setManualToolsOnly, selectedManualToolConfig, manualToolFieldValues, setManualToolFieldValues, manualToolFieldErrors, setManualToolFieldErrors, toolCatalogError, setInput, handleTextareaKeyDown, onTextareaPaste, textareaRef, input, isManualToolSelected, onAttachmentInputChange, fileInputRef, attachments, clearAttachments, attachmentNames, selectedImageModel, selectedVideoModel, selectedManualTool, selectedChatModel, activeChat, selectedModelInfo, selectedModel, onModeSelect, onModelSelect, modelLibrary }: Props) {
  return (<form className="mt-auto space-y-3" noValidate onSubmit={onSubmit}>
    {modelMode === "chat" && selectedManualToolConfig && selectedManualToolConfig.manual.fields.length > 0 ? (
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

    {modelMode === "chat" ? (
      toolCatalogError ? (
        <p className="text-[11px] text-warning">
          {tf("chat.composer.toolCatalogError", { detail: toolCatalogError })}
        </p>
      ) : manualTools.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {t("chat.composer.noManualTools")}
        </p>
      ) : selectedManualToolConfig ? (
        <p className="text-[11px] text-muted-foreground">{selectedManualToolConfig.description}</p>
      ) : null
    ) : null}

    {/* One bordered surface holds the prompt, the controls that shape it, and the
        send action. Scattering those across separate full-width rows left the
        send button visually unconnected to what it submits. */}
    <div className="rounded-xl border border-border bg-surface shadow-hairline transition-colors duration-[--dur-base] focus-within:border-foreground/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <Select
          disabled={isPending}
          onValueChange={(value) => onModeSelect(value as ModelMode)}
          value={modelMode}
        >
          <SelectTrigger aria-label={t("chat.toolbar.modeChat")} className="h-7 w-auto gap-1.5 bg-transparent text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat">{t("chat.toolbar.modeChat")}</SelectItem>
            <SelectItem value="image">{t("chat.toolbar.modeImage")}</SelectItem>
            <SelectItem value="video">{t("chat.toolbar.modeVideo")}</SelectItem>
          </SelectContent>
        </Select>
        <Select disabled={isPending} onValueChange={onModelSelect} value={selectedModel ?? "none"}>
          <SelectTrigger
            aria-label={t("chat.toolbar.modelSelectLabel")}
            className="h-7 w-auto max-w-[220px] gap-1.5 bg-transparent text-xs"
          >
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("chat.toolbar.modelNone")}</SelectItem>
            {selectedModel && !modelLibrary.some((model) => model.modelId === selectedModel && model.modes.includes(modelMode)) ? (
              <SelectItem value={selectedModel}>
                {tf("chat.toolbar.modelUnavailable", { modelId: selectedModel })}
              </SelectItem>
            ) : null}
            {modelLibrary
              .filter((model: ModelLibraryItem) => model.modes.includes(modelMode))
              .map((model) => (
                <SelectItem key={model.modelId} value={model.modelId}>
                  {model.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>

        {modelMode === "chat" ? (
          <>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
            <Select
              disabled={isPending}
              onValueChange={(value) => setSelectedManualTool(value as ManualToolSelection)}
              value={manualToolSelectValue}
            >
              <SelectTrigger
                aria-label={t("chat.composer.toolSelectLabel")}
                className="h-7 w-auto max-w-[190px] gap-1.5 bg-transparent text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("chat.composer.toolAutoOption")}</SelectItem>
                {manualTools.map((tool) => (
                  <SelectItem key={tool.id} value={tool.id}>
                    {tool.manual.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                checked={manualToolsOnly}
                className="h-3.5 w-3.5"
                disabled={isPending}
                onChange={(event) => setManualToolsOnly(event.target.checked)}
                type="checkbox"
              />
              <span>{t("chat.composer.manualOnly")}</span>
            </label>
          </>
        ) : null}
      </div>

      <Textarea
        className="min-h-[88px] resize-none rounded-none border-0 bg-transparent px-3 py-3 shadow-none focus-visible:ring-0"
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleTextareaKeyDown}
        onPaste={onTextareaPaste}
        placeholder={
          modelMode === "image"
            ? t("chat.composer.placeholderImage")
            : modelMode === "video"
              ? t("chat.composer.placeholderVideo")
              : selectedManualToolConfig
                ? selectedManualToolConfig.manual.placeholder
                : t("chat.composer.placeholderChat")
        }
        ref={textareaRef}
        rows={1}
        value={input}
      />

      <div className="flex items-center justify-between gap-2 px-3 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* The native control renders untranslated browser chrome inside an
              otherwise Chinese UI, so the label carries the visible copy and the
              input names itself. The selected filenames are announced from our
              own live region rather than left to the browser's default. */}
          <label
            className={cn(
              "inline-flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors duration-[--dur-fast]",
              "hover:bg-accent hover:text-foreground",
              isManualToolSelected && "pointer-events-none opacity-50",
            )}
          >
            <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
            {t("chat.composer.chooseFile")}
            <input
              accept={IMAGE_MEDIA_TYPES.join(",")}
              aria-label={t("chat.composer.fileInputLabel")}
              className="sr-only"
              disabled={isManualToolSelected}
              multiple
              onChange={onAttachmentInputChange}
              ref={fileInputRef}
              type="file"
            />
          </label>
          {/* Visible hint stays exactly as before; this second, hidden node
              exists only so a screen reader hears the attachment state in the
              interface language instead of the browser's own wording. */}
          {attachmentNames.length > 0 ? (
            <span className="truncate text-[11px] text-muted-foreground">
              {attachmentNames.join(t("chat.composer.attachmentSeparator"))}
            </span>
          ) : (
            <span className="truncate text-[11px] text-muted-foreground">
              {isManualToolSelected
                ? t("chat.composer.attachmentsBlocked")
                : t("chat.composer.pasteHint")}
            </span>
          )}
          <span aria-live="polite" className="sr-only">
            {attachmentNames.length > 0
              ? tf("chat.composer.attachmentsSelected", {
                  count: attachmentNames.length,
                  names: attachmentNames.join(t("chat.composer.attachmentSeparator")),
                })
              : ""}
          </span>
          {attachments.length > 0 ? (
            <Button onClick={clearAttachments} size="sm" type="button" variant="ghost">
              {tf("chat.composer.clearAttachments", { count: attachments.length })}
            </Button>
          ) : null}
        </div>

        <Button
          className="shrink-0"
          disabled={isPending || (!input.trim() && attachments.length === 0)}
          type="submit"
        >
          {isPending ? (
            <>
              <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
              {t("chat.composer.thinking")}
            </>
          ) : (
            <>
              <SendHorizonal aria-hidden="true" className="mr-2 h-4 w-4" />
              {isManualToolSelected
                ? selectedManualToolConfig?.manual.submitLabel ?? t("chat.composer.runTool")
                : t("chat.composer.send")}
            </>
          )}
        </Button>
      </div>
    </div>

    {/*
      With no model configured there is no capability to report, and the
      `!selectedModelInfo?.supportsImageInput` test is true precisely because
      the model is missing. Rendering the notice there interpolated a null
      model id into the UI, so the unconfigured case gets its own setup hint
      and the capability notice is only reachable once a model is selected.
    */}
    {modelMode === "image" ? (
      <p className="text-[13px] text-muted-foreground">
        {tf("chat.composer.statusImageModel", { modelId: selectedImageModel ?? t("chat.composer.notSelected") })}
      </p>
    ) : modelMode === "video" ? (
      <p className="text-[13px] text-muted-foreground">
        {tf("chat.composer.statusVideoModel", { modelId: selectedVideoModel ?? t("chat.composer.notSelected") })}
      </p>
    ) : isManualToolSelected ? (
      <p className="text-[13px] text-muted-foreground">
        {t("chat.composer.statusManualTool")} · {selectedManualToolConfig?.id ?? selectedManualTool} · {t("chat.composer.autoToolCall")}
        {manualToolsOnly ? t("chat.composer.disabled") : t("chat.composer.enabled")}
      </p>
    ) : !selectedChatModel ? (
      <p className="text-xs text-muted-foreground">{t("chat.composer.noModelSelected")}</p>
    ) : !selectedModelInfo?.supportsImageInput ? (
      <p className="text-[13px] text-muted-foreground">
        {tf("chat.composer.textOnlyModel", { modelId: selectedChatModel })}
      </p>
    ) : attachments.length > 0 ? (
      <p className="text-[13px] text-muted-foreground">
        {t("chat.composer.selectedAttachmentsPrefix")} {attachments.length} {t("chat.composer.selectedAttachmentsSuffix")}
      </p>
    ) : (
      <p className="text-[13px] text-muted-foreground">
        {tf("chat.composer.currentConversation", { title: activeChat?.title ?? t("chat.composer.notCreated") })} · {t("chat.composer.messageAutoSave")}
      </p>
    )}
  </form>);
}
