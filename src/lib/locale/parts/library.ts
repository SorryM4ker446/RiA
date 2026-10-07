/**
 * Media library, storage panel and knowledge-base copy.
 *
 * Split out of `zh-CN` by area so parallel edits never collide; the orchestrator
 * re-joins this object with the other parts.
 *
 * Punctuation rule applied throughout: a word that belongs to a runtime value
 * (a count, a size, a filename) stays in its own key and the template supplies
 * the space or separator around it, so another language can put the value
 * wherever it needs. Punctuation that merely terminates a static phrase — a
 * full-width colon, comma or period — stays inside that phrase's key.
 */
export const libraryMessages = {
  // --- media asset detail -------------------------------------------------
  // The E2E suite selects this region by its accessible name, so the rendered
  // heading and aria-label must keep matching "媒体详情" character for character.
  "asset.detailTitle": "媒体详情",
  "asset.closeDetail": "关闭详情",
  "asset.previewFailed": "无法预览此文件。文件可能已丢失，或当前浏览器不支持其编码；可以尝试下载。",
  "asset.previewAlt": "媒体预览",
  "asset.typeAndSize": "类型 / 大小",
  "asset.createdAt": "创建时间",
  "asset.model": "模型",
  "asset.unrecorded": "未记录",
  "asset.resourceId": "资源编号",
  "asset.references": "引用",
  "asset.messageUnit": "条消息",
  "asset.generationUnit": "个生成结果",
  "asset.originalPrompt": "原始提示词",
  "asset.savedDescription": "已保存的描述",
  "asset.unrecordedText": "未记录文本",
  "asset.generationParams": "生成参数",
  "asset.quantity": "数量：1",
  "asset.aspectRatio": "比例：",
  "asset.duration": "时长：",
  "asset.fps": "帧率：",
  "asset.seconds": "秒",
  "asset.modelDefault": "模型默认",
  "asset.otherOptions": "其他选项：模型默认",
  "asset.recipeNote": "这里记录提交的请求参数；服务商支持情况和模型默认值可能变化，不保证输出完全相同。",
  "asset.referenceImages": "参考图：",
  "asset.imageUnit": "张",
  "asset.viewReference": "查看参考图",
  "asset.noRecipe": "没有完整生成参数；上传附件和早期资源仍可预览、下载及安全删除。",
  "asset.sourceChats": "来源与关联会话",
  // Purely a suffix on the chat title, so the brackets ride along with it.
  "asset.generationSource": "（生成来源）",
  "asset.reopenChat": "恢复并打开会话",
  "asset.openChat": "打开会话",
  "asset.noSource": "未记录来源，或相关会话已删除。",
  "asset.chatMessageLimit": "这里只显示前 10 条消息的关联会话。",
  "asset.viewDependency": "查看依赖结果",
  "asset.dependencyLimit": "这里只显示前 10 个依赖结果。",
  "asset.download": "下载原文件",
  "asset.regenerate": "重新生成",
  "asset.delete": "删除资源",
  "asset.stillReferenced": "此资源仍被引用。先移除相关消息或依赖结果，才能删除文件。",

  // --- storage panel ------------------------------------------------------
  "mediaStorage.loadError": "无法读取存储信息",
  "mediaStorage.readFailed": "读取失败",
  "mediaStorage.cleanupFailed": "清理失败",
  "mediaStorage.cleaned": "已清理",
  // One static run: the comma here separates two fixed words, not a value, so
  // splitting it would only force the template to hard-code the spacing.
  "mediaStorage.freedFiles": "个文件，释放",
  "mediaStorage.mib": "MiB。",
  "mediaStorage.failedSuffix": "项暂未清理，可稍后重试。",
  "mediaStorage.title": "媒体存储",
  "mediaStorage.description": "图片、视频和附件保存在本机数据目录，不随应用构建被替换。",
  "mediaStorage.diskUsage": "磁盘占用",
  "mediaStorage.assetCount": "媒体资产",
  "mediaStorage.referenced": "被消息或生成结果引用",
  "mediaStorage.unreferenced": "未被引用",
  "mediaStorage.reclaimable": "可清理文件",
  "mediaStorage.loading": "正在读取…",
  "mediaStorage.empty": "暂无存储信息",
  "mediaStorage.retentionNote": "删除消息或会话只解除媒体引用。媒体至少保留 24 小时；清理仅移除不再被任何消息引用的过期文件，不会影响其他会话共用或被生成结果依赖的参考图。清理后文件无法恢复，请先备份需要保留的数据。",
  "mediaStorage.refresh": "刷新统计",
  "mediaStorage.confirmCleanup": "确认清理过期文件",
  "mediaStorage.cancel": "取消",
  "mediaStorage.cleanup": "清理未使用媒体",

  // --- knowledge base -----------------------------------------------------
  "documents.requestFailed": "文档操作失败，请稍后重试。",
  "documents.actionFailed": "文档操作失败。",
  "documents.selectFirst": "请先选择文档。",
  "documents.tooLarge": "文档不能超过 8 MiB。",
  "documents.unchanged": "文档内容未变化，已保留现有索引。",
  // A count framed by brackets keeps both marks as their own keys: the number
  // between them is a runtime value, not part of either phrase.
  "documents.countOpen": "（",
  "documents.countClose": "）",
  "documents.libraryTitle": "文档知识库",
  "documents.libraryDescription": "本地解析 PDF、Markdown、TXT、Word .docx，支持关键词与语义检索；每份最多 8 MiB、十万字符，最多保存 100 份。",
  "documents.textOnlyNote": "仅保存提取文本，不保留原文件及排版。同名文件会更新原文档并复用未变化的片段。聊天时，命中的片段会随问题发送给你配置的模型。导入与关键词索引在本地完成；构建语义索引会发送片段给所选 embedding 模型，构建和语义检索可能产生费用。扫描 PDF 请先 OCR，旧版 .doc 请先转换为 .docx。",
  "documents.fileLabel": "选择知识文档",
  "documents.fileButton": "选择文档",
  "documents.import": "导入文档",
  "documents.importedTitle": "已导入文档",
  "documents.refresh": "刷新文档",
  "documents.loading": "正在读取文档…",
  "documents.empty": "暂无导入文档。",
  "documents.chunkUnit": "个片段",
  "documents.characterUnit": "字符",
  "documents.indexedAt": "索引时间",
  // Formatting locale for timestamps; travels with the copy so a language
  // switch changes the date format without touching the component.
  "documents.dateLocale": "zh-CN",
  "documents.reindex": "重新索引",
  "documents.reindexed": "已根据保存的文本重建索引。",
  "documents.deleteLabel": "删除文档",
  "documents.deleteConfirmPrefix": "删除文档「",
  "documents.deleteConfirmSuffix": "」及其索引？已有聊天中的引用摘录会保留。",
  "documents.deleted": "文档及索引已删除。",
  "documents.delete": "删除",
  // Kept apart from the button copy: a translator may want the field's
  // accessible name to differ from the visible label.
  "documents.searchLabel": "检索文档",
  "documents.searchPlaceholder": "检索已导入文档中的内容",
  "documents.search": "检索文档",
  "documents.noMatches": "当前未检索到支持这个问题的资料。可换一种表述、调整集合，或补充资料并构建语义索引。",
  "documents.backToLibrary": "返回知识库",
  "documents.fallbackTitle": "文档来源",
  "documents.extractedTextNote": "以下为当前保存的提取文本，可能与原文件排版不同。相邻长片段包含少量重叠。",
  "documents.outdated": "资料版本或原引用片段已变化，以下展示文档当前版本；聊天中的摘录保留了回答时的内容。",
  "documents.sourcesTitle": "文档参考",
  "documents.sourcesNote": "回答的参考证据，包含命中片段及必要的相邻上下文。请核对引用；没有资料支持的事实不应由模型补造。",
  "documents.chunkLabel": "片段",
  "documents.pageLabel": "第",
  "documents.pageUnit": "页",
  "documents.savedSummary": "已保存：新增 {added}、复用 {reused}、移除 {removed} {unit}",
} as const;
