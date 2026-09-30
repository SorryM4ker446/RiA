/**
 * Copy for the client-side feature hooks and the two components the first sweep
 * missed: the conversation management row, the feature API clients, the chat
 * state hook, the manual-tool plumbing, media generation, task loading, chat
 * preferences, message presentation, and the theme toggle.
 *
 * The orchestrator spreads this into `zh-CN` alongside the other parts, so the
 * key prefixes here (`conversationRow`, `conversationsApi`, `chatApi`,
 * `chatState`, `tools`, `mediaGen`, `conversationsHook`, `chatPrefs`,
 * `chatMsg`, `mediaApi`, `settingsApi`) are chosen to stay disjoint from the
 * `nav`/`chat`/`conversations`/`media`/`models`/`settings`/`asset`/`api`
 * prefixes the other parts already own. A duplicate key would silently win the
 * spread, so the areas that could have reused an existing prefix get their own.
 *
 * Where a string genuinely is the same word with the same meaning as a key
 * another part already owns, the component calls that key directly instead of
 * duplicating it here — for example `conversations.filter.stateArchived` for
 * "已归档", `chat.conversations.messageCountUnit` for "条消息",
 * `chat.tasks.statusTodo` for "待处理", and `media.filter.*` for the asset
 * kind labels.
 *
 * Punctuation rule: a mark glued to a runtime value (a model id, a tool name, a
 * count) stays in the component so a translator can move the value; a mark that
 * only closes a static phrase stays inside that phrase's key.
 */
export const clientMessages = {
  // --- conversation management row (src/app/conversations) -----------------
  "conversationRow.select": "选择",
  "conversationRow.pinned": "已置顶",
  "conversationRow.reopenAndOpen": "恢复并打开",
  "conversationRow.unpin": "取消置顶",
  "conversationRow.pin": "置顶",
  "conversationRow.restore": "恢复",
  "conversationRow.archive": "归档",
  "conversationRow.editTags": "编辑标签",
  // Only the verb is copy; "Markdown"/"JSON" are the export format names the
  // E2E suite builds its selector from, so the template supplies the space.
  "conversationRow.export": "导出",
  "conversationRow.tagsLabel": "标签（逗号分隔）",
  "conversationRow.tagsHint": "最多 8 个，每个最多 32 字符；统一小写，留空可清除。",
  "conversationRow.saveTags": "保存标签",

  // --- conversation management API client ----------------------------------
  "conversationsApi.actFailed": "会话操作失败，请重试。",
  "conversationsApi.exportFailed": "导出失败，请重试。",

  // --- chat feature API client ---------------------------------------------
  // These double as the fallback a hook shows when a call rejects with
  // something that is not an Error, so the hook and the client share a key.
  "chatApi.listConversationsFailed": "读取会话列表失败",
  "chatApi.getConversationFailed": "读取会话失败",
  "chatApi.createConversationFailed": "创建会话失败",
  "chatApi.renameConversationFailed": "重命名会话失败",
  "chatApi.setEphemeralFailed": "修改会话设置失败。",
  "chatApi.setDocumentScopeFailed": "修改资料范围失败。",
  "chatApi.deleteConversationFailed": "删除会话失败",
  "chatApi.listMessagesFailed": "读取历史消息失败",
  "chatApi.saveEditFailed": "保存修改失败",
  "chatApi.deleteMessageFailed": "删除消息失败",
  "chatApi.listToolsFailed": "读取工具目录失败",
  "chatApi.listTasksFailed": "读取任务失败",
  "chatApi.updateTaskFailed": "更新任务失败",
  "chatApi.deleteTaskFailed": "删除任务失败",
  "chatApi.imageGenerateFailed": "图片生成失败",
  "chatApi.videoGenerateFailed": "视频生成失败",
  "chatApi.readImageFailed": "读取图片失败，无法加入图片附件。",
  "chatApi.persistMessageFailed": "保存消息失败",
  "chatApi.uploadAttachmentFailed": "附件上传失败",
  // Suffix for `${tool} 执行失败`: the tool id is a runtime value and the
  // space between them is layout, so neither travels with the key.
  "chatApi.runToolFailed": "执行失败",

  // --- chat state hook ------------------------------------------------------
  "chatState.requestFailed": "聊天请求失败，请稍后重试。",
  "chatState.loadOlderFailed": "读取更早消息失败",
  "chatState.deleteFailed": "删除失败",
  // Saved as the assistant message body when a stream is cut off, so the text
  // is user-visible; it stays a plain sentence with no trailing punctuation of
  // its own.
  "chatState.streamInterrupted": "（响应中断，已保存当前输出）",
  "chatState.regenerateFailed": "重新生成失败",
  "chatState.noModelSelected": "请先在“模型与用量”中添加并选择当前模式的模型。",
  "chatState.manualToolAttachmentBlocked": "手动工具调用暂不支持附件，请先清空附件。",
  // A model id is interpolated between the two halves, so neither half carries
  // the surrounding spaces.
  "chatState.imageInputUnsupportedPrefix": "当前聊天模型",
  "chatState.imageInputUnsupportedSuffix": "不支持图片输入，请切换视觉模型或移除附件。",
  "chatState.toolParamsRequired": "请在输入框中填写工具参数。",
  "chatState.toolRunFailed": "工具执行失败",
  // Default title for a brand new conversation; the user's own text replaces
  // it as soon as the model answers.
  "chatState.defaultChatTitle": "聊天消息",
  "chatState.sendFailed": "发送消息失败",
  "chatState.sendContextLost": "会话已切换或历史加载失败，请重新加载会话后再发送。",

  // --- manual tool field validation (src/features/chat/tool-input.ts) ------
  "tools.fieldRequired": "请填写此项",
  "tools.fieldInvalidNumber": "请输入有效数字",
  // Both are a static lead-in for the bound value; the space is supplied by the
  // template so the number can be positioned independently.
  "tools.fieldMinPrefix": "最小值为",
  "tools.fieldMaxPrefix": "最大值为",

  // --- manual tool execution (src/features/chat/use-tools.ts) --------------
  "tools.needChatModel": "请先在“模型与用量”中添加并选择聊天模型。",
  "tools.manualCallTitlePrefix": "手动工具调用:",
  "tools.manualCallTextPrefix": "手动调用工具",
  "tools.runningPrefix": "正在执行",
  // The corner brackets hug the tool id, so they travel with the static halves
  // and the id is interpolated bare between them.
  "tools.completedPrefix": "已完成工具「",
  "tools.completedSuffix": "」调用。",
  "tools.failedText": "工具执行失败。",

  // --- media generation hook -----------------------------------------------
  "mediaGen.kindImage": "图片",
  "mediaGen.kindVideo": "视频",
  "mediaGen.needModel": "请先在“模型与用量”中添加并选择模型。",
  // "图片生成" / "视频生成" — the kind word above is reused because the noun is
  // the same one the media filters already show.
  "mediaGen.defaultTitleSuffix": "生成",
  "mediaGen.generatingPrefix": "正在生成",
  "mediaGen.completedSuffix": "生成完成",
  "mediaGen.failedSuffix": "生成失败，请稍后重试。",
  "mediaGen.failedShortSuffix": "生成失败",
  "mediaGen.videoReferenceLimit": "视频生成最多使用 1 个参考图。",
  "mediaGen.untitledFile": "未命名文件",
  "mediaGen.reuseEdit": "继续编辑",
  "mediaGen.reuseAsk": "带图追问",
  "mediaGen.reuseVideoRef": "用作视频参考",
  "mediaGen.attachImageFailed": "加入图片附件失败",

  // --- conversations hook (src/features/chat/use-conversations.ts) ---------
  "conversationsHook.loadMoreFailed": "读取更多会话失败",

  // --- chat preferences -----------------------------------------------------
  "chatPrefs.defaultsLoadFailed": "无法读取默认模型。",
  "chatPrefs.staleModelWarning": "此会话保存的模型已不在“我的模型”中，请重新选择。",

  // --- message presentation -------------------------------------------------
  // One shared lead-in instead of six copies of "来源：", so a translator can
  // move the qualifier without rewriting the whole label.
  "chatMsg.sourcePrefix": "来源：",
  "chatMsg.sourceSystem": "系统",
  "chatMsg.sourceContext": "上下文推理",
  "chatMsg.sourceWebSearch": "搜索工具 + 模型推理",
  "chatMsg.sourceKnowledge": "知识库工具 + 模型推理",
  "chatMsg.sourceTask": "任务工具结果",
  "chatMsg.sourceTool": "工具结果",
  "chatMsg.priorityHigh": "高",
  "chatMsg.priorityMedium": "中",
  "chatMsg.priorityLow": "低",

  // --- media API client -----------------------------------------------------
  "mediaApi.actFailed": "媒体操作失败，请重试。",
  "mediaApi.credentialExpired": "本地访问凭证已失效，请从本机重新打开应用。",
  "mediaApi.fileUnavailable": "媒体文件不可用，请刷新后重试。",

  // --- settings API client --------------------------------------------------
  "settingsApi.actFailed": "操作失败，请刷新后重试。",
  "nav.backToChat": "返回聊天",
} as const;
