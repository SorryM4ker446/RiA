import { providerIdSchema, type ProviderId } from "@/lib/models/preferences-schema";
import { deepseekProvider } from "@/lib/models/providers/deepseek";
import { openRouterProvider } from "@/lib/models/providers/openrouter";
import type { ModelProvider } from "@/lib/models/providers/types";

export * from "@/lib/models/providers/types";
export { DEEPSEEK_BASE_URL, DEEPSEEK_CAPABILITY_RULES, defaultThinking } from "@/lib/models/providers/deepseek";

const providers = new Map<ProviderId, ModelProvider>([
  [openRouterProvider.id, openRouterProvider],
  [deepseekProvider.id, deepseekProvider],
]);

export function getModelProvider(providerId: string): ModelProvider {
  const parsed = providerIdSchema.safeParse(providerId);
  const provider = parsed.success ? providers.get(parsed.data) : undefined;
  if (!provider) throw new Error(`Unknown model provider: ${providerId}`);
  return provider;
}

export function listModelProviders(): ModelProvider[] {
  return [...providers.values()];
}
