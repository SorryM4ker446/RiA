export type RegistryHeader = {
  key: string;
  value: string;
  required: boolean;
  description: string;
  placeholder: string;
};

export type RegistryRemote = {
  type: string;
  url: string;
  headers: RegistryHeader[];
  unavailableReason: string | null;
};

export type RegistryServer = {
  name: string;
  title: string;
  description: string;
  version: string;
  status: "active" | "deprecated";
  repositoryUrl: string | null;
  websiteUrl: string | null;
  updatedAt: string | null;
  remotes: RegistryRemote[];
  packages: { registry: string; identifier: string; version: string; transport: string }[];
};

export type RegistryPage = {
  items: RegistryServer[];
  nextCursor: string | null;
  skipped: number;
  fetchedAt: string;
};

/** A transient configuration draft. It grants no tool or process permissions. */
export type RegistryConnectionDraft = {
  name: string;
  url: string;
  headers: RegistryHeader[];
  source: { name: string; version: string };
};
