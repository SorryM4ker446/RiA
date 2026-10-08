import Link from "next/link";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { attachmentLabel } from "@/features/chat/draft";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { t, tf } from "@/lib/locale";
import { IMAGE_MEDIA_TYPES } from "@/lib/media/limits";
import { cn } from "@/lib/utils/cn";
import { Loader2, Paperclip, SendHorizonal, Square, X } from "lucide-react";
import { getManualToolFieldError } from "@/features/chat/tool-input";
import type { ManualToolSelection } from "@/features/chat/types";
import type { ChatState } from "@/features/chat/use-chat-state";
import { ModelMode } from "@/features/chat/page-utils";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";

type Props = Pick<
  ChatState,
  | "onStop"
  | "onSubmit"
  | "modelMode"
  | "isPending"
  | "isDocumentScopeSaving"
  | "setSelectedManualTool"
  | "manualToolSelectValue"
  | "manualTools"
  | "manualToolsOnly"
  | "setManualToolsOnly"
  | "selectedManualToolConfig"
  | "manualToolFieldValues"
  | "setManualToolFieldValues"
  | "manualToolFieldErrors"
  | "setManualToolFieldErrors"
  | "toolCatalogError"
  | "unavailableTools"
  | "setInput"
  | "handleTextareaKeyDown"
  | "onTextareaPaste"
  | "textareaRef"
  | "input"
  | "isManualToolSelected"
  | "onAttachmentInputChange"
  | "fileInputRef"
  | "attachments"
  | "isUploadingAttachments"
  | "isDraggingFiles"
  | "onComposerDragOver"
  | "onComposerDragLeave"
  | "onComposerDrop"
  | "clearAttachments"
  | "removeAttachmentAt"
  | "attachmentNames"
  | "selectedImageModel"
  | "selectedVideoModel"
  | "selectedManualTool"
  | "selectedChatModel"
  | "activeChat"
  | "selectedModelInfo"
  | "selectedModel"
  | "onModeSelect"
  | "onModelSelect"
  | "modelLibrary"
>;
export function Composer({
  onStop,
  onSubmit,
  modelMode,
  isPending,
  isDocumentScopeSaving,
  setSelectedManualTool,
  manualToolSelectValue,
  manualTools,
  manualToolsOnly,
  setManualToolsOnly,
  selectedManualToolConfig,
  manualToolFieldValues,
  setManualToolFieldValues,
  manualToolFieldErrors,
  setManualToolFieldErrors,
  toolCatalogError,
  unavailableTools,
  setInput,
  handleTextareaKeyDown,
  onTextareaPaste,
  textareaRef,
  input,
  isManualToolSelected,
  onAttachmentInputChange,
  fileInputRef,
  attachments,
  isUploadingAttachments,
  isDraggingFiles,
  onComposerDragOver,
  onComposerDragLeave,
  onComposerDrop,
  clearAttachments,
  removeAttachmentAt,
  attachmentNames,
  selectedImageModel,
  selectedVideoModel,
  selectedManualTool,
  selectedChatModel,
  activeChat,
  selectedModelInfo,
  selectedModel,
  onModeSelect,
  onModelSelect,
  modelLibrary,
}: Props) {
  return (
    <form
      className={cn(
        "mx-auto w-full max-w-3xl space-y-2 rounded-xl transition-shadow duration-[--dur-fast]",
        // Only lit while a real file drag is over the composer, so a drag of
        // selected text does not look like an invitation to drop a file.
        isDraggingFiles &&
          "ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
      noValidate
      onDragLeave={onComposerDragLeave}
      onDragOver={onComposerDragOver}
      onDrop={onComposerDrop}
      onSubmit={onSubmit}
    >
      {modelMode === "chat" &&
      selectedManualToolConfig &&
      selectedManualToolConfig.manual.fields.length > 0 ? (
        <div className="grid gap-2 rounded-xl border border-border/60 bg-card/70 p-3 md:grid-cols-3">
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
                      <SelectItem
                        key={`${field.key}-${option.value}`}
                        value={option.value}
                      >
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
                      const nextError = getManualToolFieldError(
                        field,
                        nextValue,
                      );
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
          <p className="text-[11px] text-muted-foreground">
            {selectedManualToolConfig.description}
          </p>
        ) : null
      ) : null}

      {/* One bordered surface holds the prompt, the controls that shape it, and the
        send action. Scattering those across separate full-width rows left the
        send button visually unconnected to what it submits. */}
      <div className="composer-surface rounded-2xl border border-border bg-surface/80 shadow-card transition-colors duration-[--dur-base] focus-within:border-foreground/20">
        <Textarea
          className="composer-input block h-28 min-h-0 resize-none overflow-y-auto rounded-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0"
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
          rows={4}
          value={input}
        />
        {/*
        A thumbnail is worth more than a file name here: the user is deciding
        whether the right picture got attached, and a name cannot answer that.
        Each one removes itself rather than only offering "remove all", because
        fixing a wrong pick should not cost the picks that were right.
      */}
        {attachments.length > 0 ? (
          <ul
            className="flex flex-wrap gap-2 px-3 pt-3"
            aria-label={t("chat.composer.attachmentListLabel")}
          >
            {attachments.map((attachment, index) => (
              <li className="group relative" key={`${attachment.url}-${index}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- the asset
                  lives behind the local credential, which a next/image loader
                  would fetch without it. */}
                <img
                  alt={attachmentLabel(attachment)}
                  className="h-14 w-14 rounded-md border border-border object-cover"
                  src={attachment.url}
                />
                <button
                  aria-label={t("chat.composer.removeAttachment")}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => removeAttachmentAt(index)}
                  type="button"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {isUploadingAttachments ? (
          <p
            className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-muted-foreground"
            role="status"
          >
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("chat.composer.uploadingAttachment")}
          </p>
        ) : null}

        <div className="flex items-end justify-between gap-2 px-3 pb-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {/* The native control renders untranslated browser chrome inside an
              otherwise Chinese UI, so the label carries the visible copy and the
              input names itself. The selected filenames are announced from our
              own live region rather than left to the browser's default. */}
            <label
              className={cn(
                "inline-flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md text-xs text-muted-foreground transition-colors focus-within:ring-1 focus-within:ring-ring",
                "hover:bg-accent hover:text-foreground",
                isManualToolSelected && "pointer-events-none opacity-50",
              )}
            >
              <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="sr-only">{t("chat.composer.chooseFile")}</span>
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
            <Select
              disabled={isPending}
              onValueChange={(value) => onModeSelect(value as ModelMode)}
              value={modelMode}
            >
              <SelectTrigger
                aria-label={t("chat.toolbar.modeChat")}
                className="h-7 w-auto gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/60"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="chat">
                  {t("chat.toolbar.modeChat")}
                </SelectItem>
                <SelectItem value="image">
                  {t("chat.toolbar.modeImage")}
                </SelectItem>
                <SelectItem value="video">
                  {t("chat.toolbar.modeVideo")}
                </SelectItem>
              </SelectContent>
            </Select>
            <Select
              disabled={isPending || isDocumentScopeSaving || (modelMode === "chat" && !!activeChat?.assistantConfig?.model)}
              onValueChange={onModelSelect}
              value={selectedModel ? modelRefKey(selectedModel) : "none"}
            >
              <SelectTrigger
                aria-label={t("chat.toolbar.modelSelectLabel")}
                className="h-7 w-auto max-w-[180px] gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/60"
              >
                <SelectValue className="truncate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("chat.toolbar.modelNone")}
                </SelectItem>
                {selectedModel &&
                !modelLibrary.some(
                  (model) =>
                    modelRefKey(model) === modelRefKey(selectedModel) &&
                    model.modes.includes(modelMode),
                ) ? (
                  <SelectItem value={modelRefKey(selectedModel)}>
                    {tf("chat.toolbar.modelUnavailable", {
                      modelId: selectedModel.modelId,
                    })}
                  </SelectItem>
                ) : null}
                {modelLibrary
                  .filter((model: ModelLibraryItem) =>
                    model.modes.includes(modelMode),
                  )
                  .map((model) => (
                    <SelectItem
                      key={modelRefKey(model)}
                      value={modelRefKey(model)}
                    >
                      {model.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>

            {modelMode === "chat" ? (
              <>
                <span
                  aria-hidden="true"
                  className="mx-0.5 h-4 w-px bg-border"
                />
                <Select
                  disabled={isPending}
                  onValueChange={(value) =>
                    setSelectedManualTool(value as ManualToolSelection)
                  }
                  value={manualToolSelectValue}
                >
                  <SelectTrigger
                    aria-label={t("chat.composer.toolSelectLabel")}
                    className="h-7 w-auto max-w-[160px] gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent/60"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("chat.composer.toolAutoOption")}
                    </SelectItem>
                    {unavailableTools.map((tool) => (
                      <SelectItem
                        disabled
                        key={tool.id}
                        value={`unavailable-${tool.id}`}
                      >
                        {`${tool.displayName}（${t("chat.composer.toolNotConfigured")}）`}
                      </SelectItem>
                    ))}
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
                    onChange={(event) =>
                      setManualToolsOnly(event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span>{t("chat.composer.manualOnly")}</span>
                </label>
              </>
            ) : null}

            {/* Visible hint stays exactly as before; this second, hidden node
              exists only so a screen reader hears the attachment state in the
              interface language instead of the browser's own wording. */}
            {attachmentNames.length > 0 ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {attachmentNames.join(t("chat.composer.attachmentSeparator"))}
              </span>
            ) : (
              <span className="sr-only">
                {isManualToolSelected
                  ? t("chat.composer.attachmentsBlocked")
                  : t("chat.composer.pasteHint")}
              </span>
            )}
            <span aria-live="polite" className="sr-only">
              {attachmentNames.length > 0
                ? tf("chat.composer.attachmentsSelected", {
                    count: attachmentNames.length,
                    names: attachmentNames.join(
                      t("chat.composer.attachmentSeparator"),
                    ),
                  })
                : ""}
            </span>
            {attachments.length > 0 ? (
              <Button
                onClick={clearAttachments}
                size="sm"
                type="button"
                variant="ghost"
              >
                {tf("chat.composer.clearAttachments", {
                  count: attachments.length,
                })}
              </Button>
            ) : null}
          </div>

          {/* Stopping replaces sending while a turn is running. The label says
            exactly that: the request to the provider is abandoned, not undone,
            and anything already produced stays on screen. */}
          {isPending ? (
            <Button
              aria-label={t("chat.composer.stop")}
              className="h-8 w-8 shrink-0 rounded-full px-0"
              onClick={onStop}
              type="button"
              variant="secondary"
            >
              <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
              <span className="sr-only">{t("chat.composer.stop")}</span>
            </Button>
          ) : (
            <Button
              className="h-8 w-8 shrink-0 rounded-full px-0"
              disabled={isDocumentScopeSaving || (!input.trim() && attachments.length === 0)}
              type="submit"
            >
              <SendHorizonal aria-hidden="true" className="h-4 w-4" />
              <span className="sr-only">
                {isManualToolSelected
                  ? (selectedManualToolConfig?.manual.submitLabel ??
                    t("chat.composer.runTool"))
                  : t("chat.composer.send")}
              </span>
            </Button>
          )}
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
        <p className="text-[11px] leading-4 text-muted-foreground">
          {tf("chat.composer.statusImageModel", {
            modelId:
              selectedImageModel?.modelId ?? t("chat.composer.notSelected"),
          })}
        </p>
      ) : selectedModelInfo?.providerSearch ? (
        /* A model that searches on its own bills the search itself. Saying so at
         the point of selection is the only place the user can still change
         their mind before the next message costs anything. */
        <p className="text-[13px] text-warning">
          {t("chat.composer.providerSearchNote")}
        </p>
      ) : modelMode === "video" ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {tf("chat.composer.statusVideoModel", {
            modelId:
              selectedVideoModel?.modelId ?? t("chat.composer.notSelected"),
          })}
        </p>
      ) : isManualToolSelected ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t("chat.composer.statusManualTool")} ·{" "}
          {selectedManualToolConfig?.id ?? selectedManualTool} ·{" "}
          {t("chat.composer.autoToolCall")}
          {manualToolsOnly
            ? t("chat.composer.disabled")
            : t("chat.composer.enabled")}
        </p>
      ) : !selectedChatModel ? (
        <p className="text-xs text-muted-foreground">
          {t("chat.composer.noModelSelected")}{" "}
          <Link
            href="/models"
            className="ml-1 text-foreground underline decoration-border underline-offset-4"
          >
            {t("chat.composer.configureModels")}
          </Link>
        </p>
      ) : attachments.length > 0 && !selectedModelInfo?.supportsImageInput ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {tf("chat.composer.textOnlyModel", {
            modelId: selectedChatModel.modelId,
          })}
        </p>
      ) : attachments.length > 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t("chat.composer.selectedAttachmentsPrefix")} {attachments.length}{" "}
          {t("chat.composer.selectedAttachmentsSuffix")}
        </p>
      ) : null}
    </form>
  );
}
