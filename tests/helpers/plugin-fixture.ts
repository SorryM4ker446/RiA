import { echoSchema } from "./extension-service";

export function pluginFixture(origin?: string, kind: "http" | "mcp-http" = "mcp-http") {
  return {
    format: "ria-plugin", schemaVersion: 1, id: "test.research-pack", name: "Research bundle", version: "1.0.0", author: "Fixture publisher",
    description: "A synthetic skill and optional service for package lifecycle acceptance.",
    skills: [{ id: "research", name: "Research skill", description: "Use for package acceptance questions.", instructions: "PLUGIN_SKILL_EVIDENCE: distinguish verified facts from assumptions. Use only permitted tools and wait for external approval." }],
    connections: origin ? [{ id: "service", name: "Package echo", config: kind === "http" ? { type: kind, url: `${origin}/http`, method: "POST", description: "Echo a fixture value", inputSchema: echoSchema } : { type: kind, url: `${origin}/mcp` }, credentials: [{ key: "Authorization", required: true, description: "Fixture credential, including Bearer prefix." }] }] : [],
  };
}
