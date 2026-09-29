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
  "tools.common.submitLabel": "执行工具",

  // --- searchKnowledge ----------------------------------------------------
  "tools.searchKnowledge.displayName": "知识检索",
  "tools.searchKnowledge.primaryFieldLabel": "检索词",
  "tools.searchKnowledge.description": "检索已导入的文档、知识记忆和内置知识，并返回可引用结果。",
  "tools.searchKnowledge.manualLabel": "手动：知识检索",
  "tools.searchKnowledge.placeholder": "输入要检索的关键词...（Enter 手动触发）",
  "tools.searchKnowledge.noResults": "我在当前知识库里没有找到和“{query}”直接相关的内容。",
  "tools.searchKnowledge.sourceDocument": "根据文档《{title}》",
  "tools.searchKnowledge.sourceMemory": "根据你的知识库记忆",
  "tools.searchKnowledge.sourceBuiltin": "根据内置知识",
  "tools.searchKnowledge.sourceSeparator": "，",
  "tools.searchKnowledge.hitOne": "查询「{query}」命中 1 条：{title}（{source}）",
  "tools.searchKnowledge.hitMany": "查询「{query}」命中 {total} 条，首条为 {title}（{source}）",

  // --- createTask --------------------------------------------------------
  "tools.createTask.displayName": "创建任务",
  "tools.createTask.primaryFieldLabel": "任务标题",
  "tools.createTask.detailLabel": "任务详情",
  "tools.createTask.priorityLabel": "优先级",
  "tools.createTask.priorityPlaceholder": "留空由模型决定",
  "tools.createTask.dueLabel": "截止时间",
  "tools.createTask.description":
    "为当前用户创建任务，支持截止时间、IANA timeZone（默认 UTC）、reminderEnabled 桌面到期提醒和 repeatRule（none/daily/weekly/monthly，完成后续建）。提醒和重复都需要 dueDate；无偏移时间按 timeZone 解释。",
  "tools.createTask.manualLabel": "手动：创建任务",
  "tools.createTask.placeholder": "输入任务标题...（Enter 手动触发）",
  "tools.createTask.detailPlaceholder": "任务详情（可选）",
  "tools.createTask.duePrefix": "，截止时间 {value}（{timeZone}）",
  "tools.createTask.reminderSuffix": "，桌面运行时到期提醒",
  "tools.createTask.repeatSuffix": "，重复规则 {rule}（完成后续建）",
  "tools.createTask.created": "已创建任务「{title}」{due}{reminder}{repeat}，当前状态为 {status}。",
  "tools.createTask.memorySummary": "任务「{title}」已创建",
  "tools.createTask.memoryJoin": "，",

  // --- webSearch ---------------------------------------------------------
  "tools.webSearch.primaryFieldLabel": "搜索词",
  "tools.webSearch.skippedBudget": "本轮未再检索：已用完本轮的结果额度。",
  "tools.webSearch.notConfigured": "联网搜索尚未配置，本轮没有访问互联网。可在“设置 → 工具与联网”完成配置。",
  "tools.webSearch.description": "通过网络搜索获取外部信息。",
  "tools.webSearch.manualLabel": "手动：Web 搜索",
  "tools.webSearch.placeholder": "输入要搜索的关键词...（Enter 手动触发）",
  "tools.webSearch.resultCountLabel": "结果数（可空）",
  "tools.webSearch.snippetSeparator": "：",
  "tools.webSearch.noResults": "已执行 Web Search，但暂未返回可用结果：{query}",
  "tools.webSearch.completed": "已完成 Web Search，返回 {count} 条结果。",
  "tools.webSearch.expandHint": "可在下方展开查看搜索来源。",
  "tools.webSearch.memorySummary": "Web 搜索「{query}」返回 {count} 条结果。",
  // --- saveMemory ---------------------------------------------------------
  "tools.saveMemory.displayName": "记住信息",
  "tools.saveMemory.description": "保存一条关于用户的长期信息，供后续对话使用。",
  "tools.saveMemory.manualLabel": "手动：记住信息",
  "tools.saveMemory.placeholder": "输入要记住的内容...（Enter 手动触发）",
  "tools.saveMemory.primaryFieldLabel": "记忆内容",
  "tools.saveMemory.keyLabel": "记忆键",
  "tools.saveMemory.saved": "已记住：{value}（键：{key}）",

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
