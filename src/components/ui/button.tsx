import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils/cn";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

/* Vercel draws control outlines in the shadow layer rather than as a border, so
   the radius stays clean and the hairline reads lighter than a real border.
   The fill steps, not the outline, carry emphasis. */
const variantStyles: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/85",
  secondary: "bg-secondary text-secondary-foreground shadow-hairline hover:bg-secondary/80",
  outline: "bg-card text-foreground shadow-hairline hover:bg-accent",
  ghost: "text-foreground hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground shadow-hairline hover:bg-destructive/90",
};

const sizeStyles: Record<ButtonSize, string> = {
  default: "h-9 px-4 text-sm",
  sm: "h-8 px-3 text-xs",
  lg: "h-11 px-5 text-sm",
  icon: "size-9",
  "icon-sm": "size-8",
};

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  asChild = false,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium tracking-label [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        "transition-[color,background-color,box-shadow,opacity,transform] duration-[--dur-fast] ease-[--ease-out]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-45 [&:not(:disabled):not([aria-haspopup])]:active:scale-[0.97]",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...(!asChild && { type })}
      {...props}
    />
  );
}
