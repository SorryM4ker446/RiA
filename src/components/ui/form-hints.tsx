"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleAlert } from "lucide-react";
import { t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";

type FormField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Shown = { field: FormField; anchor: HTMLElement; text: string; attempt: number };

const GAP = 7, MARGIN = 8;

const isField = (target: EventTarget | null): target is FormField =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

/** Says what a field needs in the interface's own language, which the browser's sentence does not follow. */
export function validationHint(field: FormField): string {
  const { validity } = field;
  const type = field instanceof HTMLInputElement ? field.type : "";
  if (validity.valueMissing) {
    if (type === "file") return t("ui.formHint.chooseFile");
    if (type === "checkbox" || type === "radio") return t("ui.formHint.tick");
    if (field instanceof HTMLSelectElement) return t("ui.formHint.choose");
    return t("ui.formHint.fill");
  }
  if (validity.badInput) return t("ui.formHint.number");
  if (validity.typeMismatch) return type === "url" ? t("ui.formHint.url") : type === "email" ? t("ui.formHint.email") : t("ui.formHint.format");
  if (validity.rangeUnderflow) return tf("ui.formHint.min", { value: (field as HTMLInputElement).min });
  if (validity.rangeOverflow) return tf("ui.formHint.max", { value: (field as HTMLInputElement).max });
  if (validity.stepMismatch) return t("ui.formHint.step");
  if (validity.tooShort) return tf("ui.formHint.tooShort", { value: (field as HTMLInputElement).minLength });
  if (validity.tooLong) return tf("ui.formHint.tooLong", { value: (field as HTMLInputElement).maxLength });
  // The app's tooltips take `title` over, keeping the text where this looks.
  if (validity.patternMismatch) return field.title || field.dataset.tipTitle || t("ui.formHint.format");
  return field.validationMessage || t("ui.formHint.format");
}

/** What the hint points at: the field, or the visible control standing in for a hidden one. */
function anchorOf(field: FormField): HTMLElement {
  const box = field.getBoundingClientRect();
  if (box.width > 2 && box.height > 2) return field;
  const visible = [...(field.labels ?? [])].filter(label => label.getBoundingClientRect().width > 2);
  return visible.at(-1) ?? field.parentElement ?? field;
}

/** Below the field, or above it when only that fits, and always inside the window. */
function place(anchor: DOMRect, size: { width: number; height: number }) {
  const fitsBelow = anchor.bottom + GAP + size.height <= window.innerHeight - MARGIN;
  const below = fitsBelow || anchor.top - GAP - size.height < MARGIN;
  return {
    side: below ? "bottom" : "top",
    top: below ? Math.min(anchor.bottom + GAP, window.innerHeight - MARGIN - size.height) : anchor.top - GAP - size.height,
    left: Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - MARGIN - size.width)),
    arrow: Math.max(10, Math.min(anchor.left + 18 - Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - MARGIN - size.width)), size.width - 18)),
  };
}

/**
 * One hint for the whole app in place of the browser's validation bubble, which ignores
 * the theme and the interface language. Forms keep plain `required`, `min` and `type`
 * attributes and the browser still refuses the submit: this only changes how that is
 * shown, so a form added later needs nothing. A form that validates itself sets
 * `noValidate` and never reaches this.
 */
export function FormHints() {
  useLocale();
  const [shown, setShown] = useState<Shown | null>(null);
  const hint = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let attempt = 0;
    let answered = false;
    const onInvalid = (event: Event) => {
      if (!isField(event.target)) return;
      event.preventDefault();
      // A submit reports every invalid field at once; the first one is what to fix next.
      if (answered) return;
      answered = true;
      setTimeout(() => { answered = false; });
      const field = event.target;
      const anchor = anchorOf(field);
      field.focus({ preventScroll: true });
      anchor.scrollIntoView({ block: "nearest" });
      setShown({ field, anchor, text: validationHint(field), attempt: ++attempt });
    };
    document.addEventListener("invalid", onInvalid, true);
    return () => document.removeEventListener("invalid", onInvalid, true);
  }, []);

  useEffect(() => {
    if (!shown) return;
    const { field, anchor } = shown;
    const hide = () => setShown(null);
    // Ahead of anything around the field: Escape closes the hint first, and a dialog only after that.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); hide(); } };
    field.addEventListener("input", hide);
    field.addEventListener("change", hide);
    field.addEventListener("blur", hide);
    window.addEventListener("keydown", onKey, true);
    const wasInvalid = field.getAttribute("aria-invalid");
    field.setAttribute("aria-invalid", "true");
    anchor.setAttribute("data-form-invalid", "");
    // Follows the field through scrolling and layout changes, and leaves with it. Runs only while a hint is up.
    let frame = requestAnimationFrame(function follow() {
      if (!field.isConnected || !anchor.isConnected) { hide(); return; }
      if (hint.current) {
        const { side, top, left, arrow } = place(anchor.getBoundingClientRect(), { width: hint.current.offsetWidth, height: hint.current.offsetHeight });
        hint.current.dataset.side = side;
        hint.current.style.top = `${top}px`;
        hint.current.style.left = `${left}px`;
        hint.current.style.setProperty("--form-hint-arrow", `${arrow}px`);
      }
      frame = requestAnimationFrame(follow);
    });
    return () => {
      cancelAnimationFrame(frame);
      field.removeEventListener("input", hide);
      field.removeEventListener("change", hide);
      field.removeEventListener("blur", hide);
      window.removeEventListener("keydown", onKey, true);
      if (wasInvalid === null) field.removeAttribute("aria-invalid"); else field.setAttribute("aria-invalid", wasInvalid);
      anchor.removeAttribute("data-form-invalid");
    };
  }, [shown]);

  if (!shown) return null;
  return createPortal(<div ref={hint} key={shown.attempt} className="form-hint" role="alert"><CircleAlert aria-hidden="true" />{shown.text}</div>, document.body);
}
