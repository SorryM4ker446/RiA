/** Public, synthetic Registry metadata. Never describes a real user account. */
export function registryEntry(slug: string, extra: Record<string, unknown> = {}, status = "active") {
  return {
    server: { name: `io.github.ria-fixture/${slug}`, title: `Registry ${slug}`, description: `Offline MCP service ${slug}`, version: "1.2.3", repository: { url: "https://github.com/example/mcp-fixture" }, remotes: [{ type: "streamable-http", url: "https://service.example.invalid/mcp" }], ...extra },
    _meta: { "io.modelcontextprotocol.registry/official": { status, updatedAt: "2026-10-18T10:00:00Z", isLatest: true } },
  };
}

export function registryFixtureEntries(origin: string) {
  return [
    registryEntry("echo", { title: "Echo MCP", description: "用于验证发现、配置、检测与工具调用的回声服务。", remotes: [{ type: "streamable-http", url: `${origin}/mcp`, headers: [{ name: "Authorization", isRequired: true, isSecret: true, placeholder: "Bearer token", description: "填写服务访问令牌（含 Bearer 前缀）。" }] }] }),
    registryEntry("local", { title: "Local document service", remotes: [], packages: [{ registryType: "npm", identifier: "@ria-fixture/local-mcp", version: "2.0.0", transport: { type: "stdio" } }] }),
    registryEntry("sse", { title: "Legacy SSE service", remotes: [{ type: "sse", url: "https://legacy.example.invalid/sse" }] }),
    registryEntry("template", { title: "Tenant address service", remotes: [{ type: "streamable-http", url: "https://{tenant}.example.invalid/mcp" }] }),
    ...Array.from({ length: 18 }, (_, index) => registryEntry(`service-${index}`, { title: `Catalog service ${index}` })),
  ];
}
