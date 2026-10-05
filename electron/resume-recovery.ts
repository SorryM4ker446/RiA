/** One recovery owns a captured service; late work cannot replace a newer one. */
export function createResumeRecovery<T>(options: {
  current: () => T | null;
  quitting: () => boolean;
  healthy: (service: T) => Promise<boolean>;
  refreshSession: (service: T) => Promise<void>;
  restart: () => Promise<void>;
  poll: () => Promise<void>;
  failed: () => void;
}) {
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const service = options.current();
    if (!service || options.quitting()) return Promise.resolve();
    const ownsService = () => !options.quitting() && options.current() === service;
    inFlight = (async () => {
      const healthy = await options.healthy(service);
      if (!ownsService()) return;
      if (!healthy) { await options.restart(); return; }
      await options.refreshSession(service);
      if (ownsService()) await options.poll();
    })().catch(() => { if (!options.quitting()) options.failed(); }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
