import { UIMessage } from "ai";
import { t } from "@/lib/locale";
import type { SearchSourceItem } from "@/features/chat/types";
import { documentSourceSchema, markDocumentCitations, type DocumentSource } from "@/lib/documents/types";

/**
 * What this turn could not do, stated once next to the message it belongs to.
 *
 * It is read from the stored turn rather than from the live stream, so a
 * reloaded conversation says the same thing the first time did, and it never
 * becomes a claim that some other turn did not search.
 */
export function getTurnNotices(message: UIMessage): string[] {
  if (message.role !== "assistant") return [];
  const metadata = message.metadata as { unavailableTools?: unknown } | undefined;
  if (!Array.isArray(metadata?.unavailableTools)) return [];
  const labels: Record<string, string> = { webSearch: t("chat.notice.webSearchUnavailable") };
  return [...new Set(metadata.unavailableTools.filter((value): value is string => typeof value === "string").map(id => labels[id]).filter(Boolean))];
}

export function getDocumentSources(message: UIMessage): DocumentSource[] {
  if (message.role !== "assistant") return [];
  const metadata = message.metadata as { documentSources?: unknown } | undefined;
  const parse = (source: unknown) => {
    const result = documentSourceSchema.safeParse(source);
    return result.success ? [result.data] : [];
  };
  const stored = Array.isArray(metadata?.documentSources) ? metadata.documentSources.slice(0, 8).flatMap(parse) : [];
  const searched = message.parts.flatMap(part => {
    if (part.type !== "tool-searchKnowledge" || part.state !== "output-available") return [];
    const output = part.output as { results?: { reference?: unknown }[] } | undefined;
    return Array.isArray(output?.results) ? output.results.slice(0, 8).flatMap(item => parse(item?.reference)) : [];
  });
  // What a search returned is marked against the answer that followed it.
  const answer = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  return [...new Map([...stored, ...markDocumentCitations(searched, answer)].map(source => [source.chunkId, source] as const)).values()].slice(0, 8);
}

/** How the turn's knowledge lookup went: recorded by an earlier version, or from its latest search. */
export function getRetrievalDiagnostics(message: UIMessage): unknown {
  const stored = (message.metadata as { documentDiagnostics?: unknown } | undefined)?.documentDiagnostics;
  if (stored) return stored;
  const search = [...message.parts].reverse().find(part => part.type === "tool-searchKnowledge" && part.state === "output-available");
  return search && "output" in search ? (search.output as { diagnostics?: unknown } | undefined)?.diagnostics : undefined;
}

export function resolveMessageSourceTag(params: {
  role: UIMessage["role"];
  toolParts: Array<Extract<UIMessage["parts"][number], { type: `tool-${string}` }>>;
}): { label: string; variant: "outline" | "success" | "secondary" } | null {
  const { role, toolParts } = params;
  // A shared lead-in keeps one copy of the source label, so a translator can
  // move the qualifier without rewriting all six variants. The E2E suite
  // matches these rendered strings exactly, so the parts must stay adjacent.
  const source = (qualifier: Parameters<typeof t>[0]) => `${t("chatMsg.sourcePrefix")}${t(qualifier)}`;

  if (role === "system") {
    return { label: source("chatMsg.sourceSystem"), variant: "secondary" };
  }

  if (role !== "assistant") {
    return null;
  }

  if (toolParts.length === 0) {
    return { label: source("chatMsg.sourceContext"), variant: "outline" };
  }

  const toolNames = new Set(toolParts.map((part) => part.type.replace(/^tool-/, "")));
  if (toolNames.has("webSearch")) {
    return { label: source("chatMsg.sourceWebSearch"), variant: "success" };
  }
  if (toolNames.has("searchKnowledge")) {
    return { label: source("chatMsg.sourceKnowledge"), variant: "success" };
  }
  if (toolNames.has("createTask")) {
    return { label: source("chatMsg.sourceTask"), variant: "success" };
  }
  return { label: source("chatMsg.sourceTool"), variant: "success" };
}

export function getWebSearchSources(
  toolParts: Array<Extract<UIMessage["parts"][number], { type: `tool-${string}` }>>,
): SearchSourceItem[] {
  return toolParts.flatMap((part) => {
    if (part.type !== "tool-webSearch" || part.state !== "output-available") {
      return [];
    }

    const output = "output" in part ? part.output : null;
    if (!output || typeof output !== "object" || !("results" in output) || !Array.isArray(output.results)) {
      return [];
    }

    return output.results
      .filter(
        (item): item is SearchSourceItem =>
          item &&
          typeof item === "object" &&
          "title" in item &&
          typeof item.title === "string" &&
          "url" in item &&
          typeof item.url === "string",
      )
      .map((item) => ({
        title: item.title,
        url: item.url,
        ...(typeof item.snippet === "string" ? { snippet: item.snippet } : {}),
        ...(typeof item.score === "number" || item.score === null ? { score: item.score } : {}),
      }));
  });
}

const LOCAL_FILE_TOOLS = new Set(["listLocalFiles", "readLocalFile", "writeLocalFile"]);

/**
 * What a turn read or produced from a folder the user granted.
 *
 * Read off the tool parts rather than kept beside them, so the disclosure
 * cannot drift from the calls that actually happened: there is one source for
 * both the work and the statement about it. Only successful calls count — a
 * refused one read nothing, and claiming otherwise would overstate what left
 * the machine.
 */
export function getLocalFileUses(message: UIMessage): { grantLabel: string; grantId: string; path: string; toolId: string }[] {
  if (!Array.isArray(message.parts)) return [];
  const seen = new Set<string>();
  const uses: { grantLabel: string; grantId: string; path: string; toolId: string }[] = [];
  for (const part of message.parts) {
    if (typeof part?.type !== "string") continue;
    // A tool part is named `tool-<name>` everywhere else in the app — that is
    // the shape the request schema accepts and the transcript renders. Matching
    // the bare name against the prefixed one found nothing, and the disclosure
    // this function exists for never appeared.
    const toolId = part.type.replace(/^tool-/, "");
    if (!LOCAL_FILE_TOOLS.has(toolId)) continue;
    const tool = part as {
      type: string;
      input?: { grantId?: unknown; path?: unknown };
      output?: { grantLabel?: unknown; path?: unknown };
      state?: string;
    };
    if (tool.state !== "output-available") continue;
    const grantId = typeof tool.input?.grantId === "string" ? tool.input.grantId : "";
    const path = typeof tool.output?.path === "string" ? tool.output.path : typeof tool.input?.path === "string" ? tool.input.path : "";
    const grantLabel = typeof tool.output?.grantLabel === "string" ? tool.output.grantLabel : "";
    if (!path) continue;
    const key = `${toolId}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uses.push({ grantLabel, grantId, path, toolId });
  }
  return uses;
}
