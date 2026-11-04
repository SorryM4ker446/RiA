/**
 * Tool catalogue interface copy.
 *
 * Everything a person reads from a tool — the picker's labels, the field
 * placeholders, and the result summary shown in the collapsed tool panel —
 * lives here. The model-facing half of a tool (`modelDescription`) stays inline
 * in `src/tools/catalog.ts` because it is prompt text, not interface language.
 *
 * Punctuation is part of the copy, not decoration: these strings are rendered
 * directly and several are asserted verbatim by the E2E suite, so the full-width
 * marks are deliberate. Punctuation bound to a runtime value stays outside the
 * key (see `tools.*.joinSeparator` style keys below) so a translator can
 * reorder the surrounding words.
 */
export const toolsMessages = {
  // --- shared ------------------------------------------------------------
  "tools.toolCalling.displayName": "工具调用",
  "tools.toolCalling.description": "模型自己判断该用哪个工具，用完带着结果继续回答。",
  "tools.searchKnowledge.hint": "想查什么？",
  "tools.createTask.hint": "要做什么，什么时候？",
  "tools.webSearch.hint": "想搜索什么？",
  "tools.saveMemory.hint": "写下要记住的内容",
  "tools.readDocument.hint": "想了解什么？",
  "tools.convertDocument.hint": "附加文件或选择文档，发送即可转换",
  "tools.extension.hint": "说说想让它做什么",
  "lib.chat.invocation.toolNotCallable": "这个工具不能直接调用。",
  "lib.chat.invocation.toolNotInTemplate": "当前助理模板不允许使用这个工具。",
  "lib.chat.invocation.modelCannotCallTools": "当前模型不支持调用工具，请换一个模型。",
  "lib.chat.invocation.toolUnavailable": "这个工具现在不可用，请先完成配置。",
  "lib.chat.invocation.skillUnavailable": "这个技能已停用或卸载，请重新选择。",

  // --- searchKnowledge ----------------------------------------------------
  "tools.searchKnowledge.displayName": "知识检索",
  "tools.searchKnowledge.description": "在你的文档和记忆里找答案，并附上出处。",
  "tools.searchKnowledge.hitOne": "查询「{query}」命中 1 条：{title}（{source}）",
  "tools.searchKnowledge.hitMany": "查询「{query}」命中 {total} 条，首条为 {title}（{source}）",

  // --- createTask --------------------------------------------------------
  "tools.compactContext.displayName": "压缩上下文",
  "tools.compactContext.description": "对话太长时整理前面的内容，腾出空间继续。",
  "tools.createTask.displayName": "创建任务",
  "tools.createTask.priorityLabel": "优先级",
  "tools.createTask.priorityPlaceholder": "留空由模型决定",
  "tools.createTask.description": "记一件待办，可以带上时间和提醒。",

  // --- webSearch ---------------------------------------------------------
  "tools.webSearch.displayName": "联网搜索",
  "tools.webSearch.description": "上网查最新的信息和资料。",
  "tools.webSearch.resultCountLabel": "结果数（可空）",
  // --- saveMemory ---------------------------------------------------------
  "tools.saveMemory.displayName": "记住信息",
  "tools.saveMemory.description": "记下你想让它长期记住的事。",
  "tools.saveMemory.disabled": "当前会话已关闭长期记忆，无法保存。请先关闭“不记长期记忆”。",

  // --- local files ----------------------------------------------------------
  "tools.listLocalFiles.displayName": "列出资料目录",
  "tools.listLocalFiles.description": "列出你授权的目录里有什么，可按层级展开。",
  "tools.listLocalFiles.result": "{folder} 中有 {count} 项：",
  "tools.readLocalFile.displayName": "读取资料文件",
  "tools.readLocalFile.description": "读取授权目录中的一个文本、Markdown、PDF 或 Word 文件。",
  "tools.readLocalFile.result": "已读取 {path}：",
  "tools.writeLocalFile.displayName": "新建资料文件",
  "tools.writeLocalFile.description": "在授权目录中新建一个 Markdown 或纯文本文件；同名文件一律不覆盖。",
  "tools.writeLocalFile.result": "已新建 {path}（{size} 字节）。",
  "tools.localFiles.manualLabel": "手动：资料目录",
  "tools.localFiles.placeholder": "输入相对路径...（Enter 手动触发）",
  "tools.localFiles.pathPlaceholder": "相对授权目录的路径...",
  "tools.localFiles.pathLabel": "相对路径",
  "tools.localFiles.grantLabel": "授权目录 ID",
  "tools.localFiles.contentLabel": "文件内容",
  "tools.localFiles.emptyFolder": "（空）",
  "tools.localFiles.truncated": "（内容过长，已截断）",
  "tools.localFiles.noGrant": "你还没有授权任何资料目录。",
} as const;
