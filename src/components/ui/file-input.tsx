"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { t } from "@/lib/locale";

type FileInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  className?: string;
  /** Visible button copy; the accessible name stays on the input itself. */
  buttonLabel?: string;
  /** Rendered when the user has not picked a file yet. */
  placeholder?: string;
  /** Extra classes for the trigger surface, e.g. to make it full width. */
  triggerClassName?: string;
};

/**
 * A file field that looks like the rest of the interface.
 *
 * The native control draws its own button, its own "No file chosen" sentence
 * and its own OS chrome, none of which follow the palette or the interface
 * language — on Windows it stayed an English grey rectangle inside an otherwise
 * Chinese page. The real `<input type="file">` stays in the DOM, keeps its
 * accessible name and still receives `setInputFiles`, but it is visually hidden
 * behind a styled label, so both the test contract and the keyboard path
 * survive while the visible control is ours.
 */
export const FileInput = React.forwardRef<HTMLInputElement, FileInputProps>(
  ({ className, triggerClassName, buttonLabel, placeholder, disabled, id, onChange, ...props }, ref) => {
    const generatedId = React.useId();
    const inputId = id ?? generatedId;
    const [names, setNames] = React.useState<string[]>([]);

    return (
      <div className={cn("w-full", className)}>
        <label
          className={cn(
            "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md bg-elevated px-3 py-1.5 text-sm text-foreground shadow-hairline",
            "transition-[box-shadow,background-color,opacity] duration-[--dur-fast] ease-[--ease-out]",
            "hover:bg-muted focus-within:ring-2 focus-within:ring-ring",
            disabled && "pointer-events-none cursor-not-allowed opacity-50",
            triggerClassName,
          )}
          htmlFor={inputId}
        >
          <Upload aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-medium tracking-label">
            {buttonLabel ?? t("common.chooseFile")}
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
            {names.length > 0 ? names.join("、") : (placeholder ?? t("common.noFileChosen"))}
          </span>
        </label>
        <input
          className="sr-only"
          disabled={disabled}
          id={inputId}
          onChange={(event) => {
            setNames(Array.from(event.target.files ?? []).map((file) => file.name));
            onChange?.(event);
          }}
          ref={ref}
          type="file"
          {...props}
        />
      </div>
    );
  },
);
FileInput.displayName = "FileInput";
