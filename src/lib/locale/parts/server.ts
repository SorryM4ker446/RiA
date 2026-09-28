/**
 * Copy owned by the shared server-side library: model settings, media, backups,
 * documents, tasks, chat plumbing and the local HTTP layer.
 *
 * Only text a human reads belongs here. Model-facing prompts, persisted enum
 * values, API wire codes and terminal-only diagnostics stay inline next to the
 * code that owns them, because moving those would change model behaviour or
 * break stored data.
 *
 * Keys are flat and dotted, and every one starts with `lib.` so this object
 * cannot collide with the page, chat or library parts when they are spread
 * together.
 *
 * Punctuation rule: a separator that hugs a runtime value (a model id, a count,
 * a byte total) is written by the template, not baked into a key, so another
 * language can place the value wherever its own grammar needs it. Punctuation
 * that merely closes a fixed phrase stays inside that phrase's key.
 */
export const serverMessages = {
  // --- shared error rendering ---------------------------------------------
  "lib.error.fallback": "请求失败，请稍后重试。",
  // The retry hint wraps a computed number, so both halves live outside the key.
  "lib.error.retryAfterOpen": "（约 ",
  "lib.error.retryAfterClose": " 秒后可重试）",
  "lib.error.conflictHint": "。请重新加载会话以查看最新内容。",

  // --- model settings and catalog -----------------------------------------
  // "模型" is a fixed word; the space before the model id is supplied by the
  // template because it hugs the value.
  "lib.models.modelWord": "模型",
  "lib.models.removingSuffix": "正在移除，请稍后重试。",
  "lib.models.removedSuffix": "已从“我的模型”中移除。",
  "lib.models.notInLibrary": "不在“我的模型”的",
  "lib.models.notInLibraryHint": "可用清单中；请重新添加或选择其他模型。",
  "lib.models.notAdded": "该模型不在“我的模型”中。",
  "lib.models.removeConflict": "该模型正在移除，请稍后重试。",
  "lib.models.invalidSettings": "模型设置格式无效，请先导出工作区备份并检查数据。",
  "lib.models.addFirstPrefix": "请先在“模型与用量”中将模型添加到“我的模型”，并设置",
  "lib.models.addFirstSuffix": "默认模型。",
  // The three mode labels differ from `models.mode.*` on purpose: that record
  // names the tabs, these name the default-model sentence.
  "lib.models.modeChat": "聊天",
  "lib.models.modeImage": "图片",
  "lib.models.modeVideo": "视频",
  "lib.models.notInCatalog": "该模型不在已获取的官方目录中。请刷新目录后重试。",
  // SuperRefine issues shown beside the offending preference field.
  "lib.models.notYetAdded": "尚未添加到“我的模型”的",
  "lib.models.notYetAddedSuffix": "清单中",
  "lib.models.fallbackMustDiffer": "备用模型必须与默认模型不同",
  "lib.models.embeddingNotAdded": "嵌入模型尚未添加到“我的模型”",
  "lib.tools.webSearchNotConfigured": "联网搜索尚未配置，本轮没有访问互联网。",
  "lib.models.providerNotConfigured": "该服务商尚未配置密钥，请先在设置中填写后再试。",
  "lib.models.providerNoModePrefix": "该服务商不提供",
  "lib.models.providerNoModeSuffix": "模型生成，请为该模式另选服务商。",
  // Chat-capability refusals share a prefix so the model id sits in one place.
  "lib.models.chatPrefix": "当前聊天模型",
  "lib.models.chatNoTools": "不支持工具调用。",
  "lib.models.chatNoToolsApproval": "不支持工具调用，无法继续审批工具请求。",
  "lib.models.chatNoImage": "不支持图片输入。",
  "lib.models.chatNoImageSwitch": "不支持图片输入，请切换到支持视觉的模型。",

  // --- provider catalog sync ----------------------------------------------
  // The provider name is supplied by the caller, so these fragments read as the
  // tail of a sentence: "OpenRouter 聊天目录返回 HTTP 503".
  "lib.models.catalogMode.chat": "聊天",
  "lib.models.catalogMode.image": "图片生成",
  "lib.models.catalogMode.video": "视频生成",
  "lib.models.catalogMode.embedding": "嵌入",
  "lib.models.catalogHttpStatus": "目录返回 HTTP",
  "lib.models.catalogUnauthorized": "目录拒绝了当前凭据，请在设置中检查该服务商的密钥。",
  "lib.models.catalogResponseTooLarge": "模型目录响应超过大小限制。",
  "lib.models.catalogResponseEmpty": "模型目录响应为空。",
  "lib.models.catalogNotJson": "模型目录不是有效 JSON。",
  "lib.models.catalogInvalidShape": "模型目录格式无效。",
  "lib.models.catalogInvalidRowsPrefix": "目录包含 ",
  "lib.models.catalogInvalidRowsSuffix": " 条无效或重复记录。",
  "lib.models.catalogEmptySuffix": "目录为空。",
  "lib.models.catalogTimeoutSuffix": "目录连接超时。",
  "lib.models.catalogReadFailed": "模型目录读取失败。",
  "lib.models.catalogUnknownMode": "未知的模型目录类型。",
  "lib.models.catalogUnknownProvider": "未知的服务商。",

  // --- media library and attachments ---------------------------------------
  "lib.media.regenerateNoRecipe": "此资源没有完整生成参数，无法重新生成。旧资源不会推测参数。",
  "lib.media.regenerateModelGone": "原模型已从“我的模型”中移除，无法按原参数重新生成。",
  "lib.media.regenerateRefsGone": "原参考图已不可用，无法按原参数重新生成。",
  "lib.media.regenerateNoEndpoint": "当前模型没有已确认兼容的参考图端点，无法按原参数重新生成。",
  "lib.media.regenerateNoRefs": "当前模型不支持参考图，无法按原参数重新生成。",
  "lib.media.noImageEndpoint": "当前模型没有已确认兼容的参考图端点。",
  "lib.media.noOutput": "模型没有返回媒体。",
  "lib.media.tooManyAttachments": "每条消息最多添加 4 个图片附件。",
  "lib.media.unsupportedAttachmentType": "仅支持 PNG、JPEG、WebP 和 GIF 图片。",
  "lib.media.attachmentSize": "每个附件须大于 0 字节且不超过 8 MiB。",
  "lib.media.totalAttachmentSize": "附件总大小不能超过 20 MiB。",

  // --- backups -------------------------------------------------------------
  "lib.backups.invalidArchive": "备份格式、长度或校验值无效。",
  "lib.backups.workspaceTooLarge": "账户数据超出便携备份上限，请使用离线目录备份。",
  "lib.backups.legacyVideos": "存在尚未迁移的旧视频。请先打开对应会话完成媒体迁移，或停机备份数据库、媒体及旧视频目录。",
  "lib.backups.overSizeLimit": "备份超过 512 MiB 上限，请先减少数据或使用离线目录备份。",
  "lib.backups.contentTooLarge": "备份内容超过支持的大小上限。",
  "lib.backups.unsafeDirectory": "备份目录不安全。",
  "lib.backups.fileUnavailable": "备份文件不存在或不可用。",
  "lib.backups.uploadOccupied": "已有其他备份上传占用中，请稍后重试。",
  "lib.backups.uploadInProgress": "已有备份正在上传，请先取消或等待过期。",
  "lib.backups.uploadExpired": "上传已过期或不存在，请重新导入。",
  "lib.backups.binaryChunks": "请使用二进制分块上传。",
  "lib.backups.offsetMismatch": "上传偏移不一致，请重新导入。",
  "lib.backups.emptyChunk": "上传分块不能为空。",
  "lib.backups.sizeMismatch": "上传文件大小不一致。",
  "lib.backups.incompleteUpload": "备份尚未完整上传。",
  "lib.backups.approvalNotReplayed": "恢复的历史审批不会重新执行。",

  // --- documents -----------------------------------------------------------
  "lib.documents.invalidFilename": "无效的文档文件名。",
  "lib.documents.unsupportedFormat": "仅支持 PDF、UTF-8 Markdown、TXT 和 Word .docx；旧版 .doc 请先转换。",
  "lib.documents.fileTooLarge": "文档不能超过 8 MiB。",
  "lib.documents.emptyFile": "不能导入空文件。",
  "lib.documents.invalidSize": "无效的文档大小。",
  "lib.documents.magicMismatch": "文件内容与扩展名不符。",
  "lib.documents.importCancelled": "文档导入已取消。",
  "lib.documents.parserBusy": "文档解析繁忙，请稍后重试。",
  "lib.documents.parseTimeout": "文档解析超时，请拆分文件后重试。",
  "lib.documents.parseFailed": "文档解析失败或超过内存限制。",
  "lib.documents.workerEnded": "文档解析进程已结束。",
  "lib.documents.invalidText": "无效的文档文本。",
  "lib.documents.charLimit": "文档不能超过十万字符。",
  "lib.documents.modifiedOrDeleted": "文档已被修改或删除，请刷新后重试。",
  "lib.documents.tooManyDocuments": "每个用户最多保存 100 份文档，请先删除不再需要的文档。",
  "lib.documents.notFound": "文档不存在或已删除。",
  "lib.documents.tooManyChunks": "文档片段过多，请拆分文档后导入。",
  // Shared by the chunker and the parser worker: one refusal, one wording.
  "lib.documents.noSearchableText": "文档没有可检索的文本；扫描 PDF 请先进行 OCR。",
  "lib.documents.expandedTooLarge": "文档展开后过大，请拆分后导入。",
  "lib.documents.notValidDocx": "文件不是有效的 Word .docx 文档。",
  "lib.documents.macroDocx": "不支持含宏的 Word 文档。",
  "lib.documents.notUtf8": "文本文件必须使用 UTF-8 编码。",
  "lib.documents.binaryText": "文件含二进制内容，不能作为文本导入。",
  "lib.documents.encryptedPdf": "不支持加密 PDF，请先解密。",
  "lib.documents.corrupt": "文档损坏或格式不受支持。",

  // --- tasks ---------------------------------------------------------------
  "lib.tasks.localTimeMissing": "该时区不存在这个本地时间，请避开夏令时跳转时刻。",
  "lib.tasks.invalidTimeZone": "无效的 IANA 时区。",
  "lib.tasks.dueDateFormat": "截止时间需要 ISO 日期或本地日期时间。",
  "lib.tasks.invalidDueDate": "无效的截止时间。",
  "lib.tasks.invalidOffset": "无效的时间偏移量。",
  "lib.tasks.noNextDueDate": "无法计算下一次截止时间，请调整重复规则或日期。",
  "lib.tasks.dueDateRequired": "提醒和重复任务必须设置截止时间。",

  // --- chat plumbing -------------------------------------------------------
  "lib.chat.saveFailed": "回答保存失败，请重新加载会话后重试。",
  "lib.chat.generateFailed": "聊天生成或保存失败，请重试或重新加载会话。",
  "lib.chat.providerUnavailable": "模型服务暂时不可用，请稍后重试。",

  // --- local HTTP layer ----------------------------------------------------
  "lib.server.backupRestoreBusy": "正在备份或恢复数据，请稍后重试。",
  "lib.server.dataOperationFailed": "本地数据操作失败。",
  "lib.server.operationsBusy": "仍有请求正在执行，请停止生成并等待其他操作完成后重试。",
  "lib.server.localAccessMissing": "本地访问凭证缺失或无效，请从本机打开应用重新获取。",
  "lib.server.rateLimited": "请求过于频繁，请稍后重试。",
} as const;
