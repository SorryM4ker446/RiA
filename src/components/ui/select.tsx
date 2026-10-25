"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFluidWidth } from "@/lib/use-fluid-width";

const SelectInteractionContext = React.createContext<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onTriggerChange: (node: HTMLButtonElement | null) => void;
} | null>(null);

function Select({ open: controlledOpen, defaultOpen = false, onOpenChange, ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const onTriggerChange = React.useCallback((node: HTMLButtonElement | null) => { triggerRef.current = node; }, []);
  const open = controlledOpen ?? uncontrolledOpen;
  const changeOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return <SelectInteractionContext.Provider value={{ open, onOpenChange: changeOpen, triggerRef, onTriggerChange }}>
    <SelectPrimitive.Root {...props} open={open} onOpenChange={changeOpen} />
  </SelectInteractionContext.Provider>;
}

function SelectValue({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>) {
  return (
    <span className={cn("block min-w-0 truncate text-left leading-tight", className)}>
      <SelectPrimitive.Value {...props} />
    </span>
  );
}

type SelectTriggerProps = React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
  variant?: "default" | "ghost" | "chip";
  size?: "default" | "sm";
  /** Sized to its value, easing to a new width rather than pushing its neighbours aside at once. */
  fluid?: boolean;
};

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, variant = "default", size = "default", fluid = false, style, onPointerDown, onPointerCancel, onClick, ...props }, ref) => {
  const interaction = React.useContext(SelectInteractionContext);
  const closeOnClick = React.useRef(false);
  const onTriggerChange = interaction?.onTriggerChange;
  const own = React.useRef<HTMLButtonElement | null>(null);
  useFluidWidth(own, fluid);
  const composedRef = React.useCallback((node: HTMLButtonElement | null) => {
    own.current = node;
    onTriggerChange?.(node);
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
  }, [ref, onTriggerChange]);

  return (
  <SelectPrimitive.Trigger
    className={cn(
      "group flex w-full items-center justify-between gap-2 rounded-lg text-sm text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
      variant === "default" ? "border border-border bg-transparent px-3 hover:border-input hover:bg-muted/40" : variant === "chip" ? "ui-filter-chip w-auto border border-dashed border-input bg-transparent px-2.5 text-[13px] hover:bg-accent/60" : "border border-transparent bg-transparent px-2 hover:bg-accent",
      size === "sm" ? "h-8 text-xs" : "min-h-9 py-1.5",
      "transition-[box-shadow,background-color,border-color,opacity] duration-[--dur-fast] ease-[--ease-out]",
      "focus:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[placeholder]:text-muted-foreground",
      className,
    )}
    ref={composedRef}
    {...props}
    // Keep the owning trigger clickable while Radix blocks other page controls.
    style={{ ...style, ...(interaction?.open && { pointerEvents: "auto" }) }}
    onPointerDown={event => {
      onPointerDown?.(event);
      closeOnClick.current = !event.defaultPrevented && event.button === 0 && !event.ctrlKey && Boolean(interaction?.open);
      if (closeOnClick.current) event.preventDefault();
    }}
    onPointerCancel={event => { closeOnClick.current = false; onPointerCancel?.(event); }}
    onClick={event => {
      const shouldClose = closeOnClick.current;
      closeOnClick.current = false;
      onClick?.(event);
      if (!event.defaultPrevented && shouldClose) {
        event.preventDefault();
        interaction?.onOpenChange(false);
      }
    }}
  >
    <span className="min-w-0 flex-1">{children}</span>
    <SelectPrimitive.Icon asChild>
      {/* The chevron is ours, not the platform's, so it carries the palette
          and rotates with the open state. */}
      <ChevronDown className="text-muted-foreground transition-transform duration-[--dur-fast] group-data-[state=open]:rotate-180" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
  );
});
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", onPointerDownOutside, ...props }, ref) => {
  const interaction = React.useContext(SelectInteractionContext);
  return (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      className={cn(
        "ui-select-content relative z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[12rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl text-popover-foreground",
        className,
      )}
      position={position}
      collisionPadding={8}
      sideOffset={6}
      ref={ref}
      {...props}
      onPointerDownOutside={event => {
        onPointerDownOutside?.(event);
        // The trigger owns this click; outside dismissal must not close and reopen it.
        if (event.target instanceof Node && interaction?.triggerRef.current?.contains(event.target)) event.preventDefault();
      }}
    >
      <SelectPrimitive.ScrollUpButton className="flex items-center justify-center bg-popover py-1 text-muted-foreground"><ChevronUp className="size-4" aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport
        className={cn(
          "p-1",
          // Only the WIDTH is pinned to the trigger. Pinning the height to the
          // trigger too clipped the list to a single row, so a three-option
          // filter showed one option at a time; the viewport is free to grow to
          // the content, bounded by the max height on the content above.
          position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]",
        )}
      >
        <SelectPrimitive.Group>{children}</SelectPrimitive.Group>
      </SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex items-center justify-center bg-popover py-1 text-muted-foreground"><ChevronDown className="size-4" aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    className={cn(
      "relative flex min-h-9 w-full cursor-pointer select-none items-center rounded-md py-2 pl-8 pr-3 text-sm outline-none transition-colors duration-[--dur-fast]",
      "text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
      className,
    )}
    ref={ref}
    {...props}
  >
    <span className="absolute left-2.5 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check aria-hidden="true" className="h-3.5 w-3.5" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText className="block truncate">{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const EMPTY_OPTION = "__empty_option__";
const SelectGroup = SelectPrimitive.Group;
type SelectFieldProps = Omit<SelectTriggerProps, "value" | "onChange" | "children"> & {
  value?: string | number;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
};

/** A complete Select for form fields that do not need a custom trigger. */
export function SelectField({ value, defaultValue, onValueChange, children, disabled, name, className, ...props }: SelectFieldProps) {
  return <Select value={value === undefined ? undefined : String(value) || EMPTY_OPTION} defaultValue={defaultValue === undefined ? undefined : defaultValue || EMPTY_OPTION} onValueChange={next => onValueChange?.(next === EMPTY_OPTION ? "" : next)} disabled={disabled} name={name}>
    <SelectTrigger className={cn("w-auto min-w-28 max-w-full", className)} {...props}><SelectValue /></SelectTrigger>
    <SelectContent>{children}</SelectContent>
  </Select>;
}

export function SelectOption({ value, ...props }: Omit<React.ComponentPropsWithoutRef<typeof SelectItem>, "value"> & { value: string | number }) {
  return <SelectItem value={String(value) || EMPTY_OPTION} {...props} />;
}

function SelectSeparator(props: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className="my-1 h-px bg-border" {...props} />;
}

export { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue };
