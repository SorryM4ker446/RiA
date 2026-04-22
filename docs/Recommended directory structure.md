# 私人 AI 助手项目目录结构建议

适用技术栈：
- `Next.js App Router`
- `TypeScript`
- `Vercel AI SDK`
- `PostgreSQL`
- `Tailwind CSS + shadcn/ui`

设计目标：
- 先满足私人 AI 助手 MVP 开发效率。
- 保持目录边界清晰，避免业务逻辑散落在 `app` 下。
- 为后续扩展 `memory`、`RAG`、`tool calling`、多模型和多助手形态预留空间。

---

## 1. 推荐目录结构

```txt
src/
  app/
    (marketing)/
      page.tsx
      layout.tsx
    (auth)/
      login/
        page.tsx
      signup/
        page.tsx
    (chat)/
      chat/
        page.tsx
        [conversationId]/
          page.tsx
      settings/
        page.tsx
      layout.tsx
    api/
      chat/
        route.ts
      conversations/
        route.ts
      conversations/
        [id]/
          route.ts
      conversations/
        [id]/
          messages/
            route.ts
      memory/
        route.ts
      retrieval/
        route.ts
      tools/
        route.ts
    layout.tsx
    globals.css

  components/
    ui/
      button.tsx
      input.tsx
      dialog.tsx
      sheet.tsx
      dropdown-menu.tsx
      textarea.tsx
      card.tsx
      avatar.tsx
      badge.tsx
    shared/
      app-shell.tsx
      page-header.tsx
      empty-state.tsx
      loading-state.tsx
      error-state.tsx
    chat/
      chat-layout.tsx
      chat-input.tsx
      message-list.tsx
      message-item.tsx
      message-actions.tsx
      conversation-sidebar.tsx
      conversation-item.tsx
      stream-renderer.tsx
    assistant/
      assistant-avatar.tsx
      assistant-mode-switcher.tsx
      assistant-status-badge.tsx
    memory/
      memory-card.tsx
      memory-list.tsx
    rag/
      source-badge.tsx
      source-list.tsx
    tools/
      tool-call-card.tsx
      tool-result-card.tsx

  features/
    auth/
      components/
      hooks/
      server/
      schemas/
      types.ts
    chat/
      components/
      hooks/
      server/
      services/
      schemas/
      types.ts
    conversations/
      components/
      hooks/
      server/
      services/
      schemas/
      types.ts
    assistant/
      server/
      services/
      schemas/
      types.ts
    memory/
      components/
      hooks/
      server/
      services/
      schemas/
      types.ts
    rag/
      components/
      hooks/
      server/
      services/
      schemas/
      types.ts
    tools/
      components/
      hooks/
      server/
      services/
      registry/
      schemas/
      types.ts
    settings/
      components/
      hooks/
      server/
      schemas/
      types.ts

  lib/
    ai/
      client.ts
      models.ts
      stream.ts
      message-mapper.ts
      token-budget.ts
    auth/
      session.ts
      guards.ts
    utils/
      cn.ts
      dates.ts
      ids.ts
      logger.ts
    validations/
      common.ts
    constants/
      app.ts
      routes.ts
      limits.ts
    memory/
      memory-ranker.ts
      memory-formatter.ts
    rag/
      chunking.ts
      embeddings.ts
      retriever.ts
      reranker.ts
    tools/
      executor.ts
      tool-context.ts
      tool-result.ts

  db/
    schema/
      user.ts
      conversation.ts
      message.ts
      memory.ts
      document.ts
      chunk.ts
      tool-log.ts
    migrations/
    seed/
      seed.ts
    index.ts

  prompts/
    system/
      assistant.md
      chat.md
      planner.md
    memory/
      memory-extract.md
      memory-summarize.md
    rag/
      answer-with-sources.md
      query-rewrite.md
    tools/
      tool-routing.md
      tool-response-format.md

  tools/
    definitions/
      web-search.ts
      note-writer.ts
      task-planner.ts
    adapters/
      web-search.ts
      local-knowledge.ts
    registry.ts
    types.ts

  types/
    ai.ts
    auth.ts
    chat.ts
    memory.ts
    rag.ts
    tool.ts

  config/
    site.ts
    model.ts
    feature-flags.ts

  middleware.ts
```

---

## 2. 每个目录负责什么

## `src/app`
职责：
- 放页面、路由和 API 入口。
- 负责 App Router 的页面组织、布局切分和服务端路由处理。

适合放什么：
- `page.tsx`、`layout.tsx`
- `route.ts`
- 路由分组，例如 `(auth)`、`(chat)`

不建议放什么：
- 复杂业务逻辑
- 大量数据转换逻辑
- 长 Prompt 内容

原因：
- `app` 应尽量保持“路由层”角色，避免随着功能增多变成巨型杂物间。

---

## `src/components`
职责：
- 放跨功能复用的 UI 组件。
- 负责通用视图层，不直接耦合具体业务流程。

建议分层：
- `ui/`：基础原子组件，例如按钮、弹窗、输入框。
- `shared/`：项目级通用组件，例如空状态、加载状态、壳层布局。
- `chat/`、`assistant/`、`memory/`、`rag/`、`tools/`：偏展示型组件。

适合放什么：
- 聊天气泡
- 会话列表项
- Tool 调用结果卡片
- RAG 来源展示组件

不建议放什么：
- 直接访问数据库的逻辑
- 模型调用逻辑

---

## `src/features`
职责：
- 放“按业务能力划分”的主逻辑，是整个项目最核心的目录。
- 把界面、状态、服务、校验、类型按 feature 聚合，方便扩展。

为什么要有这一层：
- 私人 AI 助手后期会快速长出 `memory`、`RAG`、`tools`、`settings` 等能力。
- 如果只按技术类型分目录，代码会横向分散；按 feature 聚合更利于持续迭代。

建议每个 feature 内部保持一致结构：
- `components/`：该功能专属组件
- `hooks/`：该功能专属 hooks
- `server/`：服务端动作、查询、写入逻辑
- `services/`：业务服务，连接数据库、AI、外部工具
- `schemas/`：`zod` 校验定义
- `types.ts`：该功能自己的类型定义

关键 feature 说明：

### `features/chat`
负责：
- 聊天发送与接收
- 消息流渲染
- 聊天输入状态管理
- AI SDK 的前端接入

### `features/conversations`
负责：
- 会话列表
- 新建、删除、重命名会话
- 会话切换与会话元信息管理

### `features/assistant`
负责：
- 助手人设
- system prompt 组装
- 模式切换，例如“问答模式”“计划模式”
- 后续多助手扩展

### `features/memory`
负责：
- 用户记忆抽取
- 记忆存储、更新、召回
- 长短期记忆管理

这层是未来扩展重点，建议尽早预留。

### `features/rag`
负责：
- 文档接入
- 切片、向量化、召回、重排
- 基于来源回答与引用展示

### `features/tools`
负责：
- tool calling 编排
- 工具注册、执行、结果格式化
- 权限和上下文控制

---

## `src/lib`
职责：
- 放跨 feature 的底层能力和基础设施。
- 提供“被业务复用”的工具函数、SDK 封装和底层服务。

典型内容：

### `lib/ai`
负责：
- 模型客户端封装
- 模型映射与切换
- 流式输出封装
- 消息格式适配
- token 控制

### `lib/auth`
负责：
- session 获取
- 登录态守卫
- 用户权限判断

### `lib/memory`
负责：
- 与记忆处理相关但通用的算法
- 例如记忆排序、格式化、优先级策略

### `lib/rag`
负责：
- chunk 切分
- embedding 生成
- retrieval 抽象
- rerank 能力

### `lib/tools`
负责：
- 工具执行器
- 统一工具上下文
- 工具结果标准化

### `lib/utils`
负责：
- 通用函数，例如类名合并、日期格式、ID 生成、日志

其中：
- `cn.ts` 通常用于配合 `Tailwind CSS + shadcn/ui` 做 className 合并。

---

## `src/db`
职责：
- 放数据库相关代码。
- 管理 schema、迁移、seed、数据库连接。

建议内容：
- `schema/`：按实体拆分表结构
- `migrations/`：迁移文件
- `seed/`：初始化脚本
- `index.ts`：数据库实例导出

为什么单独放：
- AI 助手项目后续表会明显增多。
- 除了用户、会话、消息，还会新增 `memory`、`document`、`chunk`、`tool_log`。
- 独立目录有助于数据层长期维护。

数据库建议：
- 明确使用 `PostgreSQL` 作为正式数据库。
- 如果配合 `pgvector`，后续做 `RAG` 和 `memory recall` 会更顺滑。

---

## `src/prompts`
职责：
- 专门管理 Prompt 资产。
- 把 Prompt 从业务代码中抽离，避免散落在接口文件和 service 文件里。

建议分法：
- `system/`：主系统提示词
- `memory/`：记忆抽取和记忆总结 Prompt
- `rag/`：查询改写、带来源回答 Prompt
- `tools/`：工具路由和结果格式化 Prompt

为什么要独立：
- Prompt 会成为 AI 产品的重要资产。
- 后续经常需要独立调优版本，不应该和普通逻辑代码混在一起。

---

## `src/tools`
职责：
- 放“真正的工具定义和适配器”。
- 这是面向 `tool calling` 的核心目录。

建议分层：
- `definitions/`：工具输入输出定义、描述、参数 schema
- `adapters/`：具体连接外部服务或本地能力的实现
- `registry.ts`：统一注册工具
- `types.ts`：工具类型定义

和 `features/tools` 的区别：
- `features/tools` 是业务编排层，决定什么时候调用工具。
- `src/tools` 是工具资源层，定义“有哪些工具、如何执行”。

这个拆法对后续扩展很关键。

---

## `src/types`
职责：
- 放跨模块共享的类型定义。
- 避免各 feature 互相 import 内部细节。

适合放什么：
- AI 消息结构
- 会话摘要类型
- 记忆条目类型
- RAG 检索结果类型
- 工具调用结果类型

---

## `src/config`
职责：
- 放集中式配置。
- 用于统一管理站点信息、模型配置、能力开关。

建议内容：
- `site.ts`：站点名称、描述
- `model.ts`：模型白名单、默认模型、fallback 策略
- `feature-flags.ts`：memory、RAG、tools 是否开启

---

## `src/middleware.ts`
职责：
- 路由级鉴权和访问控制。
- 可用于保护聊天页、设置页等需要登录的区域。

---

## `src/components/ui`
职责：
- 放基于 `shadcn/ui` 生成和维护的基础组件。
- 作为整个项目的统一设计系统底座。

适合放什么：
- `button.tsx`
- `input.tsx`
- `textarea.tsx`
- `dialog.tsx`
- `sheet.tsx`
- `card.tsx`
- `badge.tsx`
- `avatar.tsx`

使用建议：
- 尽量通过 `components/ui` 暴露统一基础组件，不要在业务页面里反复直接拼低层样式。
- 业务组件优先组合 `shadcn/ui`，而不是重新发明一套按钮、面板和弹层。

---

## 3. 为什么这个结构适合后续扩展

### 对 `memory` 扩展友好
- `features/memory` 承担记忆业务流程。
- `lib/memory` 承担通用算法和策略。
- `db/schema/memory.ts` 承担持久化。
- `prompts/memory` 承担记忆抽取与总结提示词。

这样新增长期记忆、用户画像、记忆优先级时，不会污染聊天主链路。

### 对 `RAG` 扩展友好
- `features/rag` 负责文档接入和召回编排。
- `lib/rag` 负责切片、embedding、retrieval、rerank。
- `db/schema/document.ts` 和 `chunk.ts` 负责文档及分片存储。
- `components/rag` 负责来源展示。
- `PostgreSQL` 可作为主库，后续结合向量检索能力扩展个人知识库。

这样后续从“无知识库”升级到“个人知识库”时，结构不需要重做。

### 对 `tool calling` 扩展友好
- `features/tools` 负责调用时机和业务编排。
- `src/tools` 负责工具定义、注册和适配器。
- `prompts/tools` 负责工具使用规则。
- `components/tools` 负责前端展示调用过程和结果。

这样后续接入搜索、日历、Notion、邮件等工具会更稳定。

---

## 4. 推荐的设计原则

### 原则一：路由层薄，业务层厚
让 `app` 只负责请求入口和页面组织，核心逻辑都进入 `features` 和 `lib`。

### 原则二：Prompt 是一等资产
不要把 Prompt 到处写在 `route.ts` 里，单独沉淀到 `prompts/`。

### 原则三：工具和工具编排分离
定义工具是一层，决定何时调用工具是另一层，后续维护会轻松很多。

### 原则四：先按能力边界拆，不按页面拆
私人 AI 助手未来不是只有一个聊天页，能力边界会比页面边界更稳定。

### 原则五：预留“可插拔”能力
`memory`、`RAG`、`tools` 可以先不开启，但目录先留好，后面扩展成本更低。

### 原则六：UI 基础层统一走 Tailwind + shadcn/ui
基础组件统一沉淀在 `components/ui`，业务层只做组合，避免样式体系失控。

---

## 5. MVP 阶段最小可用版

如果你希望先快速启动，也可以先实现下面这组最小目录：

```txt
src/
  app/
  components/
  features/
    chat/
    conversations/
    assistant/
  lib/
    ai/
    auth/
    utils/
  db/
  prompts/
  tools/
  types/
```

等到第二阶段再逐步补：
- `features/memory`
- `features/rag`
- `features/tools`
- `lib/memory`
- `lib/rag`

---

## 6. 一句话理解这套结构

这套结构的核心思路是：
- `app` 管路由
- `components` 管通用 UI
- `features` 管业务能力
- `lib` 管基础设施
- `db` 管持久化
- `prompts` 管 AI 提示词资产
- `tools` 管可调用工具定义

它比较适合“先做聊天 MVP，再逐步长出 memory、RAG 和 tool calling”的私人 AI 助手项目。
