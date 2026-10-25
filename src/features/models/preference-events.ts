/**
 * Model preferences are edited in the settings window while the chat page
 * stays mounted underneath it. Each successful change is announced here, so the
 * chat page reads the library and defaults again instead of offering the ones
 * it loaded when it opened.
 */
const MODEL_PREFERENCES_CHANGED = "ria:model-preferences-changed";

export function announceModelPreferencesChanged() {
  window.dispatchEvent(new Event(MODEL_PREFERENCES_CHANGED));
}

export function onModelPreferencesChanged(listener: () => void): () => void {
  window.addEventListener(MODEL_PREFERENCES_CHANGED, listener);
  return () => window.removeEventListener(MODEL_PREFERENCES_CHANGED, listener);
}
