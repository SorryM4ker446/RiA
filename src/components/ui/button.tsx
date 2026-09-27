import * as React from "react";
import { cn } from "@/lib/utils/cn";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "lg" | "icon";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/* Vercel draws control outlines in the shadow layer rather than as a border, so
   the radius stays clean and the hairline reads lighter than a real border.
   The fill steps, not the outline, carry emphasis. */
const variantStyles: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground shadow-hairline hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground shadow-hairline hover:bg-secondary/80",
  outline: "bg-elevated text-foreground shadow-hairline hover:bg-muted",
  ghost: "text-foreground hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground shadow-hairline hover:bg-destructive/90",
};

const sizeStyles: Record<ButtonSize, string> = {
  default: "h-9 px-3.5 text-sm",
  sm: "h-8 px-2.5 text-xs",
  lg: "h-10 px-5 text-sm",
  icon: "h-8 w-8",
};

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium tracking-label",
        "transition-[color,background-color,box-shadow,opacity,transform] duration-[--dur-fast] ease-[--ease-out]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-45",
        "active:not-disabled:translate-y-px active:not-disabled:scale-[0.98]",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      type={type}
      {...props}
    />
  );
}
