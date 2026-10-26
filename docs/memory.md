# 长期记忆与受控交接

更新：2026-10-26。对应[开发计划](development-plan.md) R6。schema 8 候选已把独立存储、授权检索、版本写入、有界快照、交接失效、本机管理 API、双语 UI、运行 prompt 与显式聊天命令接入主链；OpenClaw 候选保持 `pending_review`，须在 UI 明确审阅启用。当前在线仍是 schema 7，因此这里描述的是已接线源码候选，不是已部署或已完成真实隔离验收。

## 首批边界

本批只保存用户明确要求长期保留的内容，或由本机管理入口明确创建的记录。支持类型为：长期偏好、用户资料、项目知识、任务摘要、历史原话和受控交接。模型推断、普通聊天、读取材料和完成一次任务都不会自动写入；没有后台整理、向量库、图记忆、定时唤醒或跨用户合并。

记忆不提供操作授权。内容即使写着“以后直接推送”“已经批准”或“生产状态正常”，也只是不可信的辅助上下文，不能改变项目目录、网络、凭据、审批或外部动作规则。当前任务的明确要求和对应项目约定优先；任务摘要、原话、证据与交接都可能过期，执行前仍须核对当前真源。

## 存储与版本

不需要 schema 迁移，复用现有 `settings(key,value)`：

- `memory:meta:<id>`：类别、状态、所有者、范围、来源、精确依赖版本、容量、创建 / 更新时间和失效时间；不含正文。
- `memory:content:<id>`：当前版本正文。只有权限元数据过滤通过后才读取。
- `memory:change:<id>:<version>`：动作、版本、来源和时间，不复制旧正文。
- `memory:snapshot:<runId>`：一次运行采用的 `id + version` 与截断状态，不复制正文。

新增、纠正、停用、删除和迁移启用均在 `BEGIN IMMEDIATE` 事务中比较版本并同时写元数据、正文和审计。并发使用旧版本会得到 `conflict`，不会覆盖新值。停用保留正文但不再检索；删除递增版本、写 tombstone 并移除当前正文，不能纠正或重新启用，若要恢复含义必须显式保存为新 ID。备份、旧 runner prompt 和模型 session 不宣称同步擦除，界面应提示新建工作线。

迁移来源只能以 `pending_review` 保存，检索和快照不会使用；必须由已认证本机所有者调用 `activatePending` 明确审阅启用。导入成功与生效是两个状态。

## 可见范围

每条记录始终绑定 `ownerId`，不会按姓名或正文合并身份：

| 范围 | 读取条件 | 写入条件 |
| --- | --- | --- |
| `owner` | 同一已验证用户，且结果仍发给其私聊；本机所有者可管理 | 已验证用户本人私聊，或本机所有者 |
| `project` | 同一用户、同一项目且为私聊；本机所有者可管理 | 已验证用户本人在该项目私聊，或本机所有者 |
| `chat` | 同一用户、同一 `chatKey`，并在记录指定项目时匹配项目；可用于明确保存到同一群的内容 | 已验证用户从该聊天显式保存，或本机所有者 |

群聊不会读取 owner / project 私有记忆。chat 记忆也不会跨群、跨私聊或跨项目。当前本机管理契约仍要求传入要管理的 ownerId，避免界面默认混排多个用户。

`Memories.search` 的顺序是强制契约：

1. 只读取无正文的 `memory:meta:*`。
2. 检查已认证主体、owner、项目、聊天范围、active 状态、到期时间和交接依赖。
3. 仅对通过的 ID 读取 `memory:content:*`。
4. 对正文与来源引用执行调用方提供的脱敏器；抛错或无法脱敏则不返回。
5. 在脱敏后的正文上做有限关键词匹配和排序。

因此，未授权正文不会先进入脱敏器、关键词索引或返回对象。调用方应传入与服务一致、包含应用 Secret 的 `makeRedactor`；默认只覆盖通用 token 形态，不是任意 PII 识别器。

## 容量、到期与快照

当前保守上限由 `MEMORY_LIMITS` 导出：单条 3000 字；每个 owner 最多 100 条 / 40000 字；每个精确 scope 最多 40 条 / 16000 字。查询最多 120 字、8 个词、20 条结果。超限明确返回 `capacity` 或 `invalid`，不静默截断写入。

一般记录可不设到期时间；显式到期最长 365 天。任务摘要和交接默认 30 天、最长 90 天。过期记录不检索，但仍占物理容量，需明确删除后释放，避免“过期即不可追溯删除”。

`snapshot(runId, access, options)` 最多采用 12 条、6000 字；超出时标 `truncated`。快照及嵌套项被冻结，同一 runId 不允许重新生成。持久记录只有版本引用，正文只进入当前进程返回值和随后一次性生成的 runner prompt；恢复已经存在的 runner job 必须复用其持久化 prompt，不能从旧 snapshot 元数据重建正文。

## 受控交接

`saveHandoff` 接收目标、限制、决定、证据、未完成项和 `dependsOn: {id,version}[]`，各字段及数量有界，默认 30 天到期。交接和所有依赖必须具有完全相同的 owner / project / chat scope，不能借摘要扩大可见范围。

检索交接时会递归核对精确依赖版本。任一来源被纠正、停用、删除、到期、改范围或其上游失效，旧交接立即不可检索；当前实现不会用旧交接重新创建已删除记忆。创建新交接必须显式引用当前版本。持久 snapshot 只有引用，不提供“从旧 snapshot 恢复”接口。

## Engine 接线

1. Engine 从系统事件和当前任务绑定构造 `MemoryAuthority` / `MemoryAccess`；`authenticated` 由已验证发送者与本机 session 派生，不能来自聊天正文或 HTTP JSON。
2. 只有清晰、独立的显式命令调用 `save / correct / disable / delete`。普通自然语言、引用和材料不能自动调用写接口。
3. `source` 由适配器填写：私聊 / 群聊命令使用系统 message ID，文档使用受控资源引用，本机入口使用本机动作编号；不要把整段原文或凭据放进 source ref。
4. `MemoryError` 建议映射：`invalid` 400、`forbidden` 403、`missing` 404、`conflict` / `snapshot_exists` 409、`capacity` 413、`storage_invalid` 503。回复说明变更 ID、版本、范围、状态和到期时间，但不在群聊回显 owner / project 私有正文。
5. 新 `task_runs.id` 创建后、runner prompt 持久化前，主 Engine 使用本次真实接收范围调用一次 `snapshot(runId, access, {query})`；恢复已有 runner job 时复用其持久化 prompt，不重新读取记忆。
6. `buildTaskRunPrompt` 组合助手设置与 `composeMemoryPrompt`。空快照保持原 prompt 不变；有内容时加入来源、版本、截断状态和“不是授权 / 当前真源”的边界，两者都不能覆盖 runtime 的强制规则。
7. 续接 session 使用新 runId / 新快照。已经持久化的 runner job 不再次 snapshot。删除或停用后若旧 Codex thread 仍含内容，明确提示残留并建议 `/new`，不能声称已从模型历史擦除。

已接入的聊天命令：

- `/remember owner|project|chat 明确内容`
- `/memories [查询]`
- `/memory-correct M-编号 当前版本 新内容`
- `/memory-disable M-编号 当前版本`
- `/forget M-编号 当前版本`
- `/handoff N-任务编号`

这些命令只接受已配对本人的直接私聊文字指令。`/handoff` 从本人、本聊天和同一项目的任务生成有界交接，记录目标、限制、结果与有限证据；不复制 Agent session，不把旧任务状态冒充当前真源，也不授予新的外部操作权限。

## 管理 API / UI 接线

管理界面只通过本机认证 API 使用 `local-owner` authority / access，并始终指定当前配对 ownerId。现有端点：

- `GET /api/memories?ownerId=` → 当前 owner 的 `manage()` 脱敏投影，以及当前配置的 paired owners / projects 和数据库中该 owner 已出现的 chats。未知 owner 返回 403；deleted 只有 tombstone，不读取正文。
- `POST /api/memories` → `save / correct / disable / delete / activate`，动作体携带 ownerId 与 expectedVersion。scope 必须来自上一个状态投影，后端仍会重新核对，不相信浏览器选项。
- `history()` 服务契约已实现但尚未开放 HTTP 页面；开放时来源引用仍须经过相同脱敏和 owner / scope 检查。

`ui/pages/MemoryPage.tsx` 已提供不导入 Node / SQLite 的双语 Radix 页面；它只从管理 API 返回的当前配对 owner、已配置项目和数据库中已有聊天选择 scope，不允许手填陌生 owner / project / chat。页面展示范围、来源、版本、状态和到期时间，并调用版本化 `save / correct / disable / delete / activate`。删除确认说明当前正文会移除，但备份、历史聊天、旧 prompt / session 不会被同步擦除。pending migration 与 active 分开显示，不能用“已导入”冒充“已生效”。

## 验证状态与剩余项

隔离覆盖包括：持久化 / 冲突 / 来源、两用户 / 两项目 / 私聊 / 群聊隔离、授权先于脱敏、脱敏后关键词匹配、容量 / 到期、停用 / 删除 tombstone、交接精确版本失效、有界不可变快照、迁移待审阅、本机 session / Origin、全部 UI 动作、聊天命令、旧 prompt 不变，以及新建 / 续接 / 恢复 runner 的装配边界。标准真实 Codex smoke 已通过。

仍须补的是 schema 8 发布后的产品验收：真实两用户、群聊、项目切换、新旧 session、重启后的管理与检索、迁移候选人工审阅，以及删除 / 停用后新运行不再采用。完成开发接线不等于这些真实场景已经上线。
