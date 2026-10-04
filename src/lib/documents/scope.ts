const JSON_SCOPE_PREFIX = "|scope:v1|";

// Twelve names of forty characters, including JSON escaping of control characters.
export const MAX_DOCUMENT_SCOPE_LENGTH = 3000;

export function encodeDocumentScope(collections: string[]): string {
  const names = [...new Set(collections)].sort();
  if (!names.length) return "";
  const legacy = names.join("|");
  return names.some(name => name.includes("|")) || legacy.startsWith(JSON_SCOPE_PREFIX)
    ? JSON_SCOPE_PREFIX + JSON.stringify(names)
    : legacy;
}

export function decodeDocumentScope(value: string | null | undefined): string[] {
  if (!value) return [];
  if (!value.startsWith(JSON_SCOPE_PREFIX)) return value.split("|").filter(Boolean);
  const names: unknown = JSON.parse(value.slice(JSON_SCOPE_PREFIX.length));
  if (!Array.isArray(names) || names.length > 12 || !names.every(name => typeof name === "string" && name.length > 0 && name.length <= 40)) {
    throw new Error("Invalid document collection scope");
  }
  return names;
}
