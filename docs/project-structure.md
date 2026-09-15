# 项目结构与运行模型

> 反映当前实现（单用户本地工作区，无账户体系）。日期：2026-09-15。

## 1. 产品定位

面向一人在一台设备上日常使用的本地 AI 助手。数据、媒体和知识库全部保存在本机；只在调用模型或搜索时按需联网。

应用**没有账户系统**：没有注册、登录、退出，也没有多租户隔离。保护数据的是"本地访问凭证"——只有本机的进程或页面能取得它。详见[本地访问与安全](api-security.md)。

## 2. 三种运行时

同一份业务代码，三种启动方式：

| 运行时 | `APP_RUNTIME` | 启动方式 | 数据位置 |
| --- | --- | --- | --- |
| 浏览器开发 | `web`（默认） | `npm run dev` | `.desktop-data/dev/` |
| 桌面应用 | `desktop` | `npm run desktop:dev` / 安装版 | 开发：`.desktop-data/dev/`；安装版：`%APPDATA%\Private AI Assistant\data\` |
| 自动化测试 | `test` | Playwright / Node Test | `.desktop-data/test/<run>/` 或系统临时目录 |

三者的迁移与升级走**同一套迁移器**，避免出现"某一侧少应用了迁移"。

## 3. 目录职责

```
src/app/            App Router 页面与 API 路由
src/app/api/        业务接口（除 /health 与换取凭证的入口外都需要本地凭证）
src/components/ui/  可复用 UI 基元
src/config/         模型目录与解析助手
src/db/             Prisma schema 与 SQLite 迁移
src/features/       按功能划分的客户端模块
src/lib/            共享基础设施
  ai/               AI SDK 客户端与消息编解码
  backups/          备份归档、导入、恢复与保留策略
  chat/             请求校验、上下文、流式与持久化
  conversations/    会话查询、变更与导出
  documents/        文档抽取、索引与检索
  media/            私有媒体存储、生成与迁移
  memory/           记忆存储与检索评分
  models/           模型偏好与用量记录
  local/            本地工作区身份
  server/           请求边界：安全、限流、请求体、错误
src/prompts/        提示词模板
src/tools/          工具定义与注册表
electron/           桌面主进程：窗口、服务启停、加密设置、迁移
scripts/            本地数据库、构建、打包与校验脚本
tests/              浏览器、服务端与桌面回归测试
```

## 4. 数据归属

所有业务表属于**同一个工作区**，没有 `userId`：

- `chats` / `messages` / `chat_tags`
- `media_assets` / `message_media` / `media_generation_inputs`
- `memories`、`tasks`、`knowledge_documents` / `document_chunks` / `document_terms`
- `model_requests`（用量）、`account_preferences`（单例应用偏好，主键固定为 `local`）

媒体与备份的目录名仍是 `sha256(工作区标识)`，这样已存在于磁盘上的文件不需要搬动。

## 5. 请求链路

```
浏览器 / Electron 渲染进程
    │
    ├─ 本地访问凭证（HttpOnly Cookie）
    ▼
src/proxy.ts ── 拒绝旧公开视频路径，校验 Host / Origin / 凭证
    │
    ▼
src/app/api/*/route.ts
    ├─ requireLocalWorkspace()  校验本地凭证并登记数据操作
    ├─ 统一输入校验（Zod）与请求体字节上限
    ├─ 实例级限流
    └─ 业务库（src/lib/**）
            │
            ▼
        Prisma → SQLite（单连接）
```

业务 Route Handler 的错误统一为 `{ error: { code, message, details } }` 并带 `no-store`。

## 6. 升级与数据安全

升级前会先盘点旧数据、做快照、记录要沿用的旧账户，再执行转换；失败可用快照回滚。完整流程见[本地工作区升级与恢复](workspace-upgrade.md)。

两条硬性约定：

- 任何会重写用户数据库的迁移，都必须在快照校验通过之后才执行。
- 外部网页、文档与工具输出都是数据，不能改变权限或发起新的授权。

## 7. 测试分层

| 层次 | 位置 | 覆盖内容 |
| --- | --- | --- |
| 服务端 | `tests/server/` | 真实 Route Handler、隔离 SQLite、确定性模型替身 |
| 浏览器 | `tests/e2e/` | 真实 HTTP/SQLite 的关键链路，生产构建 + standalone |
| 桌面 | `tests/desktop/` | 路径解析、迁移、打包边界与 Electron 冒烟 |

测试一律使用隔离数据库与媒体目录，不读写真实用户数据。断言边界时验证的是"无本地凭证被拒绝"，而不是已不存在的跨账户隔离。详见[测试与本地验证](testing.md)。

## 8. 文件组织约定

- 功能相关代码放 `src/features/<feature>/`。
- 路由处理器留在 `src/app/api/*`，重逻辑下沉到 `src/lib`。
- 模型 ID 集中在 `src/config/model.ts`。
- 仅服务端使用的共享设施放 `src/lib/server/*`。
- `page.tsx` 只负责状态与渲染，编解码与纯函数外移。
