"use client";

import { createContext, useContext, useEffect, useId, type ComponentProps, type RefObject } from "react";
import { SETTINGS_PARAM, type SettingsSectionId } from "@/lib/settings/sections";

export type SettingsContextValue = {
  open: (section?: SettingsSectionId, anchor?: string) => void;
  /** The sections holding edits that are not saved yet. */
  unsavedSections: ReadonlySet<SettingsSectionId>;
  markUnsaved: (id: string, section: SettingsSectionId, unsaved: boolean) => void;
  /** Whether opening added a history entry, so closing can go back over it instead of adding another. */
  pushedRef: RefObject<boolean>;
  anchor: string | null;
  clearAnchor: () => void;
};

export const SettingsContext = createContext<SettingsContextValue | null>(null);

/** The section a component is rendered in, so what it reports is filed under that section. */
export const SettingsSectionContext = createContext<SettingsSectionId | null>(null);

export function useSettingsContext() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("Settings are used outside SettingsProvider");
  return context;
}

/** Opens the settings overlay, at the default section when none is named. */
export function useOpenSettings() {
  return useSettingsContext().open;
}

/**
 * Reports that the calling section holds unsaved edits while `unsaved` is true.
 * Such a section stays open in the background while another one is viewed, and
 * closing the overlay asks before discarding it. Outside the overlay it does
 * nothing, so a section can also be shown elsewhere.
 */
export function useSettingsDirty(unsaved: boolean) {
  const markUnsaved = useContext(SettingsContext)?.markUnsaved;
  const section = useContext(SettingsSectionContext);
  const id = useId();
  useEffect(() => {
    if (!markUnsaved || !section) return;
    markUnsaved(id, section, unsaved);
    return () => markUnsaved(id, section, false);
  }, [markUnsaved, section, unsaved, id]);
}

/**
 * A link to a section of the settings. It keeps the page beneath and only
 * changes the overlay, so it works the same from a page and from inside the
 * overlay itself.
 */
export function SettingsLink({ section, anchor, onClick, ...props }: Omit<ComponentProps<"a">, "href"> & { section?: SettingsSectionId; anchor?: string }) {
  const { open } = useSettingsContext();
  return <a {...props} href={`?${SETTINGS_PARAM}=${section ?? ""}`} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(section, anchor);
  }} />;
}
