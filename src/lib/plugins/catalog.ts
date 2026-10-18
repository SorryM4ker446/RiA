import { parsePlugin } from "./schema";

// Bundled first-party entries use the same preview and installer as imported
// packages. Listing this catalog never probes a service or executes a tool.
export const pluginCatalog = [
  parsePlugin({ format: "ria-plugin", schemaVersion: 1, id: "ria.writing", name: "写作与润色", version: "1.0.0", author: "RiA", description: "整理思路、改写与校对文字，保留原意和事实。无需额外服务。", skills: [{ id: "writing", name: "写作与润色", description: "用户需要起草、改写、润色、缩写或校对文本时使用。", instructions: "先识别文本用途、读者和语气。优先交付用户要求的成稿；保留事实、数字、专名和限制条件。没有来源的事实不要补写。对于改写，改善结构和可读性；只有确有必要时简短说明关键修改。用户未给材料时，先根据已有信息起草，标出确需补充的信息。不要声称已经保存或导出文件；需要导出时使用当前获准的文档工具并遵守授权。" }] }),
  parsePlugin({ format: "ria-plugin", schemaVersion: 1, id: "ria.research", name: "资料研究", version: "1.0.0", author: "RiA", description: "围绕问题整理材料、比较证据，并形成带出处的结论。使用已有知识和工具。", skills: [{ id: "research", name: "资料研究", description: "用户需要研究问题、对比资料、汇总文献或审查结论依据时使用。", instructions: "先明确研究问题和已有材料。使用当前可用的知识检索、文件读取或联网工具查证关键事实；工具不可用时说明资料范围。区分原始材料、推论和未验证假设。比较观点时围绕同一组具体指标展开。给出简洁结论与可追溯出处，不能编造引用、网页内容或工具执行结果。遵守会话的知识范围和工具限制。" }] }),
  parsePlugin({ format: "ria-plugin", schemaVersion: 1, id: "ria.context7", name: "开发文档助手", version: "1.0.0", author: "RiA", description: "组合文档查询技能与 Context7 连接，查询库的版本文档和代码示例。", skills: [{ id: "library-docs", name: "开发文档查询", description: "用户询问软件库、框架 API、版本迁移或代码实现时使用。", instructions: "优先通过 Context7 的库匹配与文档查询工具查证问题涉及的库及其版本。先匹配库标识，再查询与用户问题直接相关的文档。以实际工具返回的内容为依据，保留版本差异，并给出可验证的代码。外部调用必须遵守授权；连接不可用时明确说明，不能假装已查询。" }], connections: [{ id: "context7", name: "Context7", config: { type: "mcp-http", url: "https://mcp.context7.com/mcp" }, credentials: [{ key: "Authorization", required: false, description: "可选：填写 Bearer 加你的 Context7 API Key，以使用更高额度。" }] }] }),
];
