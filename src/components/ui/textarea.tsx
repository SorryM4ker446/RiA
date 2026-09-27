import * as React from "react";
import { cn } from "@/lib/utils/cn";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "min-h-[88px] w-full resize-none rounded-md bg-elevated p-3 text-sm leading-relaxed text-foreground shadow-hairline",
        "placeholder:text-muted-foreground",
        "transition-[box-shadow,background-color] duration-[--dur-fast] ease-[--ease-out]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";
