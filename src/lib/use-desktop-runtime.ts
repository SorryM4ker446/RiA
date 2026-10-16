"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => Boolean(window.privateAiDesktop);
const getServerSnapshot = () => false;

/** The preload bridge is fixed for the lifetime of a document. */
export function useDesktopRuntime() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
