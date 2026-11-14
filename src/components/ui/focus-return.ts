/**
 * A menu or a list of options shrinks away for a moment when it closes, and only then hands focus back to its
 * trigger. If focus has gone somewhere by that time (another menu, a dialog one of its items opened, the field
 * the user went on to type in), it stays there: pulling it back would close that menu or send the next key press
 * to the trigger. Focus that would otherwise be lost, on the page itself or inside the popup that is going, still
 * returns to the trigger.
 */
export function focusHasMovedOn() {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body
    && !active.closest(".ui-dropdown-content[data-state='closed'], .ui-select-content[data-state='closed']");
}

/** An `onCloseAutoFocus` handler that keeps focus where it went, around whatever handler the popup already has. */
export function keepMovedFocus(handler?: (event: Event) => void) {
  return (event: Event) => {
    handler?.(event);
    if (!event.defaultPrevented && focusHasMovedOn()) event.preventDefault();
  };
}
