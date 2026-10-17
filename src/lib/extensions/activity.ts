// Only active operations live here. Persistent configuration and revisions belong to SQLite.
const state = globalThis as typeof globalThis & { extensionOperations?: Map<string, Set<AbortController>> };
const operations = state.extensionOperations ??= new Map();
export function startExtensionOperation(id: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const active = operations.get(id) ?? new Set<AbortController>();
  active.add(controller); operations.set(id, active);
  return {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
    finish() { active.delete(controller); if (!active.size && operations.get(id) === active) operations.delete(id); },
  };
}
export function cancelExtensionOperations(id: string) {
  for (const controller of operations.get(id) ?? []) controller.abort();
}
