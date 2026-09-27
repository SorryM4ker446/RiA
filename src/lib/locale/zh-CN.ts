/**
 * Simplified Chinese interface copy — the single place Chinese lives for
 * anything the user reads.
 *
 * Keys are flat and dotted so they stay greppable, and a missing key becomes a
 * type error instead of an undefined render. English will live beside this file
 * as `en-US.ts` with an identical key set; nothing else changes to switch.
 */
import { apiMessages } from "./parts/api";
import { chatMessages } from "./parts/chat";
import { clientMessages } from "./parts/client";
import { libraryMessages } from "./parts/library";
import { pageMessages } from "./parts/pages";
import { toolsMessages } from "./parts/tools";
import { serverMessages } from "./parts/server";

const base = {
  // --- shell -------------------------------------------------------------
  "brand.name": "RiA",
  "nav.home": "首页",
  "nav.chat": "聊天",
  "nav.conversations": "管理会话",
  "nav.knowledge": "知识库",
  "nav.media": "媒体资源库",
  "nav.models": "模型与用量",
  "nav.backups": "备份与恢复",
  "nav.storage": "存储管理",
  "nav.settings": "设置",
  "nav.label": "工作区导航",
  "nav.environment": "Local",
  "nav.openMenu": "打开导航",
  "nav.closeMenu": "关闭导航",

  // --- theme -------------------------------------------------------------
  "theme.toggle": "切换主题",
  "window.minimize": "最小化",
  "window.maximize": "最大化",
  "window.restore": "向下还原",
  "window.close": "关闭",

  // --- common ------------------------------------------------------------
  "common.chooseFile": "选择文件",
  "common.noFileChosen": "未选择文件",

  // --- home --------------------------------------------------------------
  "home.title": "用对话、记忆与工具调用，构建属于你的私人助手。",
  "home.description":
    "Next.js App Router + Vercel AI SDK + SQLite。核心流程已可用于日常使用，并为后续的 RAG 扩展做好准备。",
  "home.primaryAction": "开始对话",
  "home.secondaryAction": "AI SDK 文档",
  "home.feature.chat.title": "流式对话",
  "home.feature.chat.body": "兼容 `useChat`，支持多轮上下文，会话自动持久化。",
  "home.feature.memory.title": "记忆就绪",
  "home.feature.memory.body": "短期上下文 + 长期记忆检索，在生成前注入。",
  "home.feature.tools.title": "工具调用",
  "home.feature.tools.body": "已注册工具带类型化 schema，执行状态在界面中可见。",
} as const;

/**
 * Every user-facing string in the app. The per-area files are spread in so each
 * one stays owned by a single area; spreading duplicates silently, so the parts
 * must keep disjoint key prefixes.
 */
export const zhCN = { ...base, ...pageMessages, ...chatMessages, ...libraryMessages, ...serverMessages, ...apiMessages, ...clientMessages, ...toolsMessages };

export type MessageKey = keyof typeof zhCN;
