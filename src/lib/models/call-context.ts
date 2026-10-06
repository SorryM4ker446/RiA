import { AsyncLocalStorage } from "node:async_hooks";

export const callSources = ["chat", "summary", "scheduled", "tool", "embedding", "media", "unattributed"] as const;
export type CallSource = typeof callSources[number];
const state = globalThis as typeof globalThis & { modelCallContext?: AsyncLocalStorage<CallSource> };
const context = state.modelCallContext ??= new AsyncLocalStorage<CallSource>();
export const modelCallSource = (): CallSource => context.getStore() ?? "unattributed";
export function withModelCallSource<T>(source: CallSource, operation: () => T): T { return context.run(source, operation); }
