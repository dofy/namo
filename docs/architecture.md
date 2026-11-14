# 技术实现

Namo 负责身份、权限、任务调度和交付，官方 Codex app-server 负责推理与工具执行。当前只支持 Codex；其他 Agent 仅保留内部扩展接口。

技术栈：TypeScript、Node.js 24.15+、SQLite、飞书官方 SDK；本地 UI 使用 React、Radix Themes、Lucide 和 Vite。当前 schema 为 16：表与索引集中在 [schema.ts](../src/schema.ts)，初始化和版本检查集中在 [schema-migrations.ts](../src/schema-migrations.ts)。

## 主链路

```mermaid
flowchart TB
  User[用户] <--> Feishu[飞书]
  UI[本机工作台] --> Management[配置、任务与记忆管理]
  CLI[交互式终端配置] --> Management

  subgraph Namo["Namo 宿主"]
    In[身份校验<br/>入站消息持久化]
    Queue[任务调度<br/>聊天顺序、并发限制、目录互斥]
    Runner[独立 runner<br/>冻结配置与运行上下文]
    HostTools[宿主管理的工具<br/>MCP / GitHub]
    Receipts[外部操作回执<br/>执行中、已完成或结果不明]
    Wait[持久等待与恢复]
    Out[结果和证据持久化<br/>出站队列]
    Memory[长期记忆<br/>提取、范围授权、版本快照]
    DB[(SQLite)]
  end

  subgraph Codex["官方 Codex"]
    Agent[app-server<br/>推理与工具调用]
    Sandbox[沙箱<br/>授权目录与 Skills]
  end

  Feishu --> In --> Queue --> Runner --> Agent
  Agent <--> Sandbox
  Agent <--> HostTools
  HostTools --> Receipts
  Agent --> Wait --> Queue
  Agent --> Out --> Feishu
  In -.->|空闲时提取| Memory
  Memory -.->|授权检索| Runner
  Management --> Queue
  Management --> Memory
  In & Queue & Runner & Receipts & Wait & Out & Memory -.-> DB
```

工作线关联连续任务；一次任务可包含多个等待 / 恢复运行。聊天、工作线、任务与 Codex 原生 session 分别保存，不能互相当作身份或权限凭证。

消息先持久化再确认收件；调度器安排独立 runner，由 Codex 在沙箱中推理和使用获准目录、Skills。MCP 和 GitHub 请求经 Namo 宿主管理的工具访问，宿主保管凭据并记录调用回执。需要用户回答或外部条件时，任务进入持久等待，满足条件后再恢复。结果和证据先保存，再排队投递到飞书；模型完成、平台接受和用户实际收件是不同的事实。

## 模块与约束

| 模块 | 实现入口 | 必须保持的行为 |
| --- | --- | --- |
| 入站与调度 | [engine](../src/engine.ts)、[tasks](../src/tasks.ts) | 先落库再确认；同聊天串行、全局限流、重叠真实目录互斥 |
| 独立执行 | [runner](../src/runner.ts)、[worker](../src/runner-worker.ts) | 唯一运行归属；接收端重启后关联原运行，失联不重启模型；取消只停止所属进程组 |
| Codex 协议 | [connection](../src/codex-connection.ts)、[runtime](../src/runtime.ts) | 官方 provider、独立认证、目录白名单；修订回执未知时不自动重送 |
| 受限浏览器原型 | [ego-browser-prototype](../src/ego-browser-prototype.ts)、[worker](../src/runner-worker.ts) | 私聊配对用户逐任务批准；固定操作、宿主持有空间绑定；能力外操作和结果不明均不自动执行或重试 |
| 人工 / 外部等待 | [waits](../src/waits.ts)、[external-waits](../src/external-waits.ts) | 等待释放执行资源，保留聊天顺序；回答绑定身份和版本；GitHub 固定 HEAD，恢复只消费一次 |
| 身份与资源 | [access](../src/access.ts)、[path-policy](../src/path-policy.ts)、[skill-access](../src/skill-access.ts) | 组织准入保留；已准入成员共享目录与 MCP；续接与交付重验权限；Skills 仅只读开放启用的具体目录 |
| 档案与记忆 | [assistant](../src/assistant.ts)、[memory](../src/memory.ts)、[extractor](../src/memory-extractor.ts) | 档案显式启用；长期事实带来源和范围；人工纠正、停用、删除不能被自动恢复 |
| 材料与产物 | [materials](../src/materials.ts)、[image-inputs](../src/image-inputs.ts)、[artifacts](../src/artifacts.ts) | 有界读取授权原消息；图片和交付文件冻结内容；正文不能生成授权，拒绝越界及敏感路径 |
| 展示与投递 | [public-progress](../src/public-progress.ts)、[feedback](../src/feedback.ts)、[recovery](../src/recovery.ts) | 只展示公开进展与有界证据；结果先保存再发送；未知投递不重试模型或盲重发 |
| GitHub / 推送 | [github-api](../src/github-api.ts)、[github-review](../src/github-review.ts)、[approvals](../src/approvals.ts) | 固定身份与目标；写操作先存回执，未知结果不自动重试；推送批准只消费一次 |
| 管理与发布 | [management](../src/management.ts)、[terminal-config](../src/terminal-config.ts)、[config-prompts](../src/config-prompts.ts)、[service](../src/service.ts)、[release](../src/release.ts) | 工作台和终端复用配置校验、版本检查与备份；查询不迁移库；保存后排空旧队列并自动应用；校验备份后切换不可变快照 |

数值预算、状态枚举和完整字段以这些模块及 [test](../test/) 中的契约测试为准，不再逐份复制到文档。

## 关键设计

**数据与恢复。** SQLite 保存 inbox、task、run、wait、outbox 和审计。取消、回答、恢复以事务顺序决定归属；心跳过期不转移执行权，失联进程及后代核对完成前保留目录占位。模型完成、平台接受、用户收件是三类事实，不能相互推断。

开发期采用 v13 基线，不再维护 v0–12 的兼容转换。v13 / v14 可在停机备份后事务迁移到 v15。空库在一个事务中初始化，失败整体回滚；不兼容旧库明确拒绝写入，绝不自动删库。重建步骤见[运维指南](operations.md)。

| 数据域 | 独立表与约束 |
| --- | --- |
| 长期记忆 | `memories` 存归属、范围和版本；`memory_contents` 通过版本外键关联正文，授权后才读取；变更、运行快照和禁止复活指纹分别保存 |
| 自动提取 | `memory_jobs` 存状态、重试和租约；来源去重键与来源消息分别关联，不伪装成模型运行 ID |
| Git 审批 | `git_approvals` 关联任务并冻结目标与权限；`approval_jobs` 关联入站命令，按状态调度 |
| 外部等待 | `external_waits` 关联任务 / 运行；同任务只能有一个活动等待，`external_wait_links` 与人工等待一对一关联 |
| 目录快照 | `task_directories` 按任务保存规范路径；v14 历史任务以原 cwd 回填，不修改任务、消息及回执 |
| 文件交付 | `artifact_intents` 关联任务指令，`artifact_deliveries` 保存文件身份、发送 UUID 和回执状态 |

官方图片生成工具的当前线程和轮次完成事件可触发自动交付：仅从该线程的隔离生成目录读取图片，冻结到任务工作目录并记录内容哈希；持久 runner 的结果携带图片身份，接收器在任务完成或等待的事务中登记独立交付。发送前再次验证授权与文件内容，图片消息和超过平台限制的文件消息各自保留回执，未知结果不自动重发。模型正文中的路径不会触发此流程；已有明确文件交付意图指向相同内容时只交付一次。

新业务表使用 STRICT 类型、外键和状态约束；状态队列、归属查询和历史排序有对应索引。JSON 仅用于有界列表、证据和冻结快照；这些业务记录不再存入 `settings`。

**目录。** `codex.directories` 是唯一外部目录白名单，所有准入成员及群聊均可读写；MCP 保存授权后统一可用，请求的读写操作直接执行而不逐次审批，不再配置资源受众、项目或任务启用开关。新任务的 cwd 始终为独立会话目录，白名单目录只用于用户要求的文件操作。初始化必须明确输入白名单，不能默认采用进程当前目录；新实例的数据与工作目录默认在系统用户级 Namo 目录。旧配置只在兼容读取入口转换为目录列表，保存时移除旧字段并生成私有备份；旧 `readPaths` 不升级为写权限。`task_directories` 冻结每个任务的 cwd 与完整可写目录集；运行及失联占位均按这些路径互斥。共享白名单时，不同聊天也会因可写目录重叠而串行。

**上下文。** 每次运行冻结输入、可写目录、权限、助手设置和记忆版本。普通配置保存不改变既有运行及已创建的排队任务；接收器暂缓创建新任务，待旧队列完成后自动切换配置并处理已持久化的新请求。仅默认模型变化保留原生上下文；目录或执行策略变化时，在同一工作线内重建模型会话并携带有界历史摘录，旧任务保持原记录；组织授权撤销仍会阻断执行及交付。worker 通过私有管道接收生效配置，模型不继承宿主飞书 / GitHub 凭据。

**记忆。** 默认在前台任务空闲时，从直接用户消息提取有证据的长期事实；独立临时 Codex 轮次关闭外部工具、hooks、插件及沙箱网络。`global / local` 知识层级与 `shared / private / chat` 披露范围、来源目录授权分别检查；全局存储不代表公开。临时要求不写长期记忆，迁移候选须人工启用。既有 session 与历史副本不会随删除自动清除。

工作台按用户展示提取队列概况与最近 20 条记录，区分无可保存内容、候选未采用和执行失败。最多尝试三次，前台任务抢占不计失败；仅保存和展示已知错误类别，不暴露原始消息或 SDK 错误。

**后台工作。** [background-work](../src/background-work.ts) 直接查询业务队列索引，不再用触发器维护重复的调度表。审批执行中断、文件发送结果不明仍进入 `unknown`，不自动重试。

**反馈。** 默认首卡合并窗口 200 ms、进展更新间隔 5 s、状态确认间隔 30 s；这是调度配置，不是客户端时延承诺。慢表情和卡片更新不挡最终结果；只汇总真实公开事件，不展示原始思维链或编造完成比例。图片预览与流式卡片尚未实现。

**外部操作。** 所有已准入成员在私聊和群聊中共享 GitHub 账号的实际 API 权限；PR 审查和 CI 等待不隐含写操作。Git push 入口重验任务、提交、分支、远端、有效期与配置版本；该入口只提供有限保护，不是所有通用工具的强制审批边界。用户请求范围内、权限允许且设置未禁止的操作直接执行，不再逐次确认；人工等待只用于缺失的信息。

当前 MCP 调用回执尚不能保证跨任务防止重复调用：结果不明的记录按任务隔离；调用返回后若授权检查或响应大小检查失败，回执可能已记录为完成，而同任务相同参数仍可再次调用。外部状态不明时应先核对服务端结果，不应自动重复操作。回执覆盖 MCP `call`，不能仅凭相同参数判断是否为同一次逻辑操作。GitHub API 的不确定写入保护同样按任务限定。

静态 GitHub 令牌的已就绪等待恢复目前不重新查询远端授权；工具 RPC 成功返回但业务结果不明时，公开进度可能将其计为成功。runner 失联检测依赖 PID 是否存在，PID 复用可能使任务持续占位。数据目录为符号链接且白名单包含其真实路径的父目录时，私有目录拒绝规则的实际沙箱行为仍需验证。

**管理与升级。** `namo config` 在 TTY 中管理执行、组织准入、连接、助手、用户档案和更新设置，字段草稿在内存中编辑，复用管理层的权限、版本检查、保存与自动切换；Esc 返回时可放弃当前草稿，MCP OAuth 通过隐藏输入接收本地回调地址并复用原有 state、PKCE 和配置版本检查。终端入口不启动接收器；工作台的浏览器本地主题和桌面原生目录选择不适用于终端。UI 仅绑定 loopback，使用一次性启动授权、HttpOnly 会话、Host / Origin 校验和 CSP；浏览器仅导入 [ui-contract](../src/ui-contract.ts)。接收器固定在校验过的发布快照。兼容的执行代码可通过 [runtime-host](../src/runtime-host.ts) 在线替换，接收连接持续存在，切换期间消息落库后才确认收件；新任务使用新执行版本，已运行的独立 worker 保留原版本。备份使用 WAL 一致性快照；校验、加载失败保留旧执行版本，发送结果未知的记录不重放。接收器、存储或依赖不兼容时保留在线服务并拒绝热更新。维护操作见[运维指南](operations.md)。

**扩展。** [runtime-contract](../src/runtime-contract.ts) 预留执行、修订、等待、取消和证据接口；没有其他 Agent SDK、探针、注册 UI、动态加载器或多 Agent 路由。旧 Codex profile 绑定只为兼容，退休适配器不回退执行。未来插件也必须遵守统一权限、调度和投递。

## 开发与验证

从仓库根目录运行，包管理器固定为 pnpm 12.15.0，唯一锁文件为 `pnpm-lock.yaml`：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm cli ui
pnpm test
pnpm run smoke:codex
```

| scripts | 用途 |
| --- | --- |
| `build`、`build:server`、`build:ui` | 完整或单侧构建，前端构建包含类型检查 |
| `typecheck:ui`、`ui:watch` | 前端类型检查、监听构建；刷新本地工作台查看变化 |
| `test` | 构建后按现有测试源码运行隔离回归，并发为 4；忽略已删除用例的旧产物 |
| `smoke:codex` | 官方协议、账号及权限握手；加 `-- --run` 才进行真实推理 |
| `smoke:skills` | 实际沙箱中的技能读取与写入边界，不调用模型 |
| `prepack`、`cli` | 打包前构建、运行唯一命令行入口 |

测试按功能归档在 `test/`，公共等待与夹具放在 `test/helpers.ts`；新增边界用例优先补进已有套件，不按开发批次另起文件。

`pnpm pack` 生成本地验收包，不发布 npm；检查包中只有运行资源和文档，没有配置、数据、日志或认证。构建不切换已运行服务。文档修改检查本地链接及进度事实，不新增镜像实现的测试。

工作台更新日志在前端构建时自动从 Git 生成：以主线 `package.json` 的版本变化为边界，纳入合并进来的 `feat`、`fix`、`perf`、`style` 提交说明。新版本更新 `package.json` 后正常构建即可，不修改源码或 Git 索引；只包含已提交内容，显示提交说明原文，并过滤疑似敏感信息。已整理的历史版本保留中英文说明。没有完整仓库历史（包括浅克隆）的构建回退到随代码保存的历史记录，并在较新版本提示无法生成详情；分发包运行时不需要 Git。CI 获取完整历史以生成日志。

[CI](../.github/workflows/ci.yml) 在 main 推送与 PR 上运行 Node.js 24 的 Linux / macOS 构建和现有测试，再用 `node scripts/check-package.mjs` 核对包的运行文件、UI 资源及排除项；同一命令可本地复验。真实 Codex / 飞书验收保留在本机，不放入 CI。

图标统一来自 Lucide；字体现有许可证见 [assets/fonts](../assets/fonts/README.md)，Logo 使用 [namo-logo.png](../assets/namo-logo.png)。UI 文案使用稳定英文 message ID，两套语言占位符保持一致。

### Schema 16 目录迁移

`schema-directory-migration.ts` 在单个事务中将 v15 升级到 v16。v13/v14 先经过现有迁移补齐任务目录快照。删除工作线、任务、Git 审批的命名资源列；交付记录使用 `rootDirectory`，记忆和提取任务使用 `directory`，知识类别使用 `knowledge`。材料绑定和记忆导入去重记录同步转换；旧 MCP 读取凭据先保留签名上下文，校验通过后升级为新版签名。

旧名称通过历史任务和工作线的 cwd 对应真实目录。无法唯一对应时，旧 owner-directory 记忆回退到 owner 范围，旧 local 记忆回退到 global 层级；所有记录的 owner、private/chat 披露限制、正文、版本、依赖链、删除状态、审计和运行快照保持不变。多个旧名称汇入同一目录时保留所有导入记录。历史消息、提示词、事件和旧备份保留原文，不改写其中的名称。

迁移前须停止服务并创建可验证备份；迁移完成前检查外键，任何异常整体回滚，不自动清库。管理界面只检查版本，不负责执行迁移。升级后不可直接用旧版本打开 v16 数据库；回滚须连同升级前数据库、配置和版本一起恢复。
