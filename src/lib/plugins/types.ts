import type { PluginManifest } from "./schema";
export type { PluginManifest } from "./schema";
export type PluginView = {
  id: string; packageId: string; manifest: PluginManifest; digest: string;
  enabled: boolean; revision: number; createdAt: string;
  connections: { id: string; key: string; ready: boolean; name: string }[];
};
export type PluginPreview = { manifest: PluginManifest; digest: string };
