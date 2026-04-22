# TOOLS_READINESS

更新时间：2026-04-22

## 1. 当前结论（综合）

- `searchKnowledge`：7/10（可用，短板在知识源管理与检索质量保障）
- `createTask`：5/10（可创建，缺任务管理闭环）
- `webSearch`：1/10（仅占位定义，未接入执行链路）

## 2. 综合可用度清单

| 模块 | 清单项 | 当前 | 达标定义 | 优先级 |
|---|---|---|---|---|
| searchKnowledge | 工具已注册并可被模型调用 | 已有 | 聊天模式稳定触发并返回结构化结果 | P0 |
| searchKnowledge | 手动触发入口（`/api/tools/run`） | 已有 | 手动调用返回 `data + assistantText` | P0 |
| searchKnowledge | 自动触发语义门控（收紧） | 已有 | 明确动作意图 + 高置信度才触发 | P0 |
| searchKnowledge | 数据源（`memories + builtin`） | 已有 | 结果可区分 `source` 与 `score` | P0 |
| searchKnowledge | 结果可解释性（UI） | 已有 | 来源标签 + 工具详情可展开 | P0 |
| searchKnowledge | 知识库管理入口（新增/查看/删除） | 缺失 | 有独立 UI 或 API 管理知识条目 | P0 |
| searchKnowledge | 检索质量保障（评测/排序优化） | 缺失 | 有最小评测集、优化策略与回归基线 | P1 |
| searchKnowledge | 项目文档接入（非仅 memory） | 部分 | 支持文档索引、更新与检索 | P1 |
| createTask | 工具已注册并写入 `tasks` 表 | 已有 | 任务创建后数据库可查 | P0 |
| createTask | 手动/自动触发 | 已有 | 聊天模式下两种触发都可用 | P0 |
| createTask | 任务查询 API（list/detail） | 缺失 | 按用户可获取任务列表与详情 | P0 |
| createTask | 任务操作 API（update/delete/status） | 缺失 | 支持 `todo/in_progress/done` + 删除 | P0 |
| createTask | 任务管理 UI（列表/筛选/状态流转） | 缺失 | 前端可完整管理任务 | P0 |
| createTask | 时间与重复校验（dueDate/防重） | 部分 | 时区正确、同内容防重复 | P1 |
| createTask | 任务闭环（提醒/到期处理） | 缺失 | 到期提醒或计划任务机制 | P1 |
| webSearch | 工具定义与输入 schema | 已有（占位） | 有稳定输入/输出协议 | P0 |
| webSearch | 实际联网检索执行 | 缺失 | 返回真实 `title/url/snippet` 结果 | P0 |
| webSearch | 注册到工具总线（registry/chat） | 缺失 | 可被自动与手动流程调用 | P0 |
| webSearch | 手动调用入口（`/api/tools/run`） | 缺失 | 与其他工具一致可手动触发 | P0 |
| webSearch | 自动语义触发策略 | 缺失 | 明确“需外部信息”时才触发 | P1 |
| webSearch | 引用可追溯（URL/来源） | 缺失 | 回答中可展示引用来源 | P0 |
| webSearch | 限流/超时/重试/缓存 | 缺失 | 失败可恢复、成本可控 | P1 |
| 通用 | 工具仅聊天模式可用 | 已有 | 非聊天模式不可手动/被动调用工具 | P0 |
| 通用 | 历史工具详情可回看 | 已有 | 历史消息支持折叠查看 input/output | P0 |
| 通用 | 端到端测试（工具触发→DB→UI） | 缺失 | 至少 2 条 E2E 用例长期可回归 | P0 |
| 通用 | 监控与审计日志（tool call） | 部分 | 可追踪触发、输入、输出、错误、耗时 | P1 |

## 3. P0 排期建议（先可用）

### 第 1 周（2026-04-23 ~ 2026-04-29）

- `webSearch` 接入真实检索 provider（含返回结构标准化）
- `webSearch` 注册到工具总线（自动 + 手动）
- `webSearch` 回答引用显示（URL/source）
- `createTask`：新增 list/detail API

**验收：**
- 聊天模式下可手动/自动调用 `webSearch` 并返回可点击来源
- `createTask` 创建后可通过 API 查询到同一用户任务列表

### 第 2 周（2026-04-30 ~ 2026-05-06）

- `createTask`：新增 update/delete/status API
- 前端任务管理 UI（列表、筛选、状态流转、删除）
- `searchKnowledge`：知识条目管理 API（新增/查看/删除）

**验收：**
- 任务可从 `todo` 流转到 `done`，并可删除
- 知识条目可通过 API 管理并被 `searchKnowledge` 检索到

### 第 3 周（2026-05-07 ~ 2026-05-13）

- 端到端测试补齐（`searchKnowledge/createTask/webSearch`）
- 通用错误码与日志结构统一

**验收：**
- 至少 2 条稳定 E2E（工具触发→落库→UI可见）
- 关键失败场景有明确错误提示（限流、超时、权限、上游失败）

## 4. P1 排期建议（提质量）

### 第 4 周（2026-05-14 ~ 2026-05-20）

- `searchKnowledge` 检索质量评测集与排序优化
- `createTask` 时区/重复任务防重策略
- `webSearch` 触发门控优化（减少误触发）

### 第 5 周（2026-05-21 ~ 2026-05-27）

- `webSearch` 缓存、限流、重试策略
- 通用审计日志（tool call 生命周期）
- 任务提醒/到期机制设计与最小实现

## 5. 发布闸门（建议）

- P0 关闭标准：
  - 三个工具在聊天模式可稳定触发并有可追溯结果展示
  - `createTask` 具备最小管理闭环（增查改删 + 状态流转）
  - `webSearch` 具备真实检索能力与引用展示
  - 关键链路 E2E 通过

- P1 关闭标准：
  - 检索质量与误触发率有量化基线
  - 运行日志可用于问题追踪与回放
  - 性能与失败恢复策略稳定
