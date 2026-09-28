/**
 * Copy returned by the `src/app/api/**` route handlers.
 *
 * These are the strings the client renders inside alert boxes via
 * `getApiErrorMessage`, so they are interface copy and travel with the rest of
 * the locale. They stay separate from the `lib/` and `feature/` copy because
 * each route area owns its own failure wording — a translator can reword the
 * media errors without touching document or backup errors.
 *
 * Only prose is catalogued here. Error `code` discriminants, comparison
 * literals, log text, and anything forwarded to a model stay inline in the
 * route, because those are machine values rather than something a reader sees.
 */
export const apiMessages = {
  // --- backups -------------------------------------------------------------
  "api.backups.createFailed": "创建备份失败，现有数据未改变。",
  "api.backups.readFailed": "读取备份失败。",
  "api.backups.restoreFailed": "恢复失败，原有数据已保留。",
  "api.backups.deleteFailed": "删除备份失败。",
  "api.backups.importStartFailed": "开始导入失败。",
  "api.backups.importChunkFailed": "分块上传失败。",
  "api.backups.importVerifyFailed": "备份校验失败，没有恢复数据。",
  "api.backups.importCancelFailed": "取消导入失败。",

  // --- documents -----------------------------------------------------------
  "api.documents.listFailed": "读取文档列表失败。",
  "api.documents.readFailed": "读取文档失败。",
  "api.documents.deleteFailed": "删除文档失败。",
  "api.documents.importFailed": "文档导入失败，原有索引保持不变。",
  "api.documents.reindexFailed": "重新索引失败，原有索引保持不变。",
  "api.documents.searchFailed": "检索文档失败。",
  "api.documents.invalidUpload": "无效的文档上传请求。",
  "api.documents.singleFileField": "每次只能上传一个 file 文件字段。",
  "api.documents.importCancelled": "文档导入已取消。",

  // --- media library -------------------------------------------------------
  "api.media.libraryFailed": "无法读取媒体资源库。",
  "api.media.detailFailed": "无法读取媒体详情。",
  "api.media.regenerateFailed": "重新生成失败，原资源已保留。",
  // Fallback used when a stored asset has no generation recipe; the richer
  // per-asset reasons come from the media library and stay with that module.
  "api.media.regenerationParamsUnavailable": "生成参数不可用。",

  // --- models --------------------------------------------------------------
  "api.models.settingsReadFailed": "读取模型设置失败。",
  "api.models.settingsSaveFailed": "保存模型设置失败。",
  "api.runs.nothingRunning": "当前没有正在执行的轮次。",
  "api.runs.stoppedByUser": "用户停止了后续步骤",
  "api.models.libraryUpdateFailed": "更新我的模型失败。",
  "api.memory.reindexReadFailed": "读取记忆向量状态失败。",
  "api.memory.reindexFailed": "重建记忆向量失败。",
  "api.models.catalogReadFailed": "读取 OpenRouter 模型目录失败。",
  "api.models.catalogRefreshFailed": "刷新 OpenRouter 模型目录失败。",

  // --- usage ---------------------------------------------------------------
  "api.usage.readFailed": "读取用量失败。",

  // --- tools ---------------------------------------------------------------
  // The model id sits mid-sentence, so the sentence is split and the id is
  // interpolated by the caller: a translator can order the halves freely.
  "api.tools.modelUnsupportedPrefix": "当前聊天模型",
  "api.tools.modelUnsupportedSuffix": "不支持工具调用。",

  // --- media generation ----------------------------------------------------
  // The image and video routes share one fallback today, but each keeps its
  // own key so the two surfaces can be worded differently later.
  "api.image.generateFailed": "媒体生成或保存失败，请稍后重试。",
  "api.video.generateFailed": "媒体生成或保存失败，请稍后重试。",

  // --- local access --------------------------------------------------------
  "api.localAccess.notTopLevel": "本地访问凭证只能通过本机的直接访问获取。",
  "api.localAccess.codeExpired": "启动凭证已失效，请从本地服务的启动输出重新打开应用。",
  "api.localAccess.establishFailed": "无法建立本地访问凭证。",
} as const;
