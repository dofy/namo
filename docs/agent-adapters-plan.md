# 多执行器接入、切换与任务路由计划

调研日期：2026-10-27。范围为 Codex、Claude 与 Cursor 的本地执行接入。本文维护分期方案。R7.1 注册表已实现于隔离功能分支，Claude/Cursor 运行适配器仍待 R7.2/R7.3；R7.0 实测及缺口见[兼容性基线](agent-compatibility.md)，配置契约见[执行器注册表](agent-registry.md)。本轮用户已授权专用登录、少量隔离验证及 Claude-only Kaon 兼容性试验；这不授权服务切换、推送或发布。

## 结论与选型

可行。Namo 继续管理消息、任务、权限、项目锁、记忆范围与交付，各 Agent 保留自己的模型、工具循环及原生 session。统一的是 Namo 的业务契约，不要求三个执行器使用同一协议或同一份上下文文件。

| 执行器 | 推荐接入 | 备选与限制 |
| --- | --- | --- |
| Codex | 保留官方 app-server stdio 适配器 | 不为了统一协议重写已验证的运行路径 |
| Claude | 官方 `@anthropic-ai/claude-agent-sdk`，运行在独立 worker 内 | `claude -p` + JSON 流可做有限能力验证；正式接入优先 SDK 的类型与控制入口 |
| Cursor | 官方 CLI 的 `agent acp`，通过 stdio JSON-RPC 对接 | 官方 `@cursor/sdk` 的 local 模式作为替代评估；headless JSON 流用于基础诊断，不默认使用 `--force` / `--yolo` |

建议先做适配器契约与 Codex 无行为变化的迁移，再完成 Claude、Cursor，随后提供按任务选择与显式交接。自动按任务类型选 Agent 在手动选择稳定后做；同一任务自动拆分给多个 Agent 不属于首期。

## 官方依据与需要验证的差异

### Claude

- [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)：SDK 在调用方进程环境运行 Claude Code 能力，提供工具、权限、hooks 与 session；不是只调用聊天模型的 Client SDK。Namo 无需重建工具循环。公开产品的展示名称可使用 “Claude”，底层适配器说明使用 Claude Agent SDK，避免混淆产品品牌。
- [会话](https://code.claude.com/docs/en/agent-sdk/sessions)：支持按确切 session ID 恢复及分叉。Namo 必须保存 ID，不能用“继续当前目录最近一次对话”替代工作线绑定。
- [流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)及[程序化 CLI](https://code.claude.com/docs/en/headless)：支持结构化输出和持续交互路径，但消息排队 / 中断不等同 Codex `turn/steer` 的接受语义，运行中修订须单独验证。
- [权限与提问](https://code.claude.com/docs/en/agent-sdk/user-input)：可通过 `canUseTool` 处理需批准的工具及 `AskUserQuestion`。自动获批工具不会经过该回调，不能把它当作覆盖所有工具的安全拦截器；[权限文档](https://code.claude.com/docs/en/agent-sdk/permissions)中的工具集、授权规则、模式与沙箱需分别映射，不采用绕过权限模式作为默认方案。
- [配置加载](https://code.claude.com/docs/en/agent-sdk/claude-code-features)：显式限制 `settingSources`，但空列表不代表完全不读宿主配置；托管策略、部分全局配置和记忆另有加载规则。需验证专用配置目录、环境白名单、原生自动记忆和项目 hooks / MCP 的边界，不复制个人认证文件，不尝试绕过组织策略。
- 认证需区分个人本机使用和公开产品分发。[官方帮助中心](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)在 2026-10-07 更新中说明订阅登录的 SDK / `claude -p` 仍消耗订阅额度，关联 Console 的 API key 使用另一条额度路径；SDK 概览仍提示第三方产品提供 claude.ai 登录 / 额度需要批准。两页的适用范围不能擅自合并为通用授权。公开版先支持用户自带官方 API key；本机已有官方登录作为待核实选项，发布前复核集成方式与届时条款，不承诺所有订阅或部署方式都可用。

### Cursor

- [ACP 官方文档](https://cursor.com/docs/cli/acp)：提供本地 stdio 双向协议，可新建 / 加载 session、提交任务、接收更新、响应工具权限请求并取消；另有提问和计划确认扩展。因此比单向解析终端文字更适合 Namo 的飞书交互。首版只对实际握手和验证过的能力开放；运行中 steer、进程丢失后的待答调用恢复不能由“支持 ACP”推导出来。
- [CLI 参数](https://cursor.com/docs/cli/reference/parameters)及[headless 模式](https://cursor.com/docs/cli/headless)：官方命令当前为 `agent`，支持指定工作区、model、session 和 JSON 流。旧环境可能出现 `cursor-agent`，发现时需验证二进制身份与协议，不能因 PATH 中有一个通用名称 `agent` 就信任它。headless 写入示例使用 `--force`，不直接照搬到 Namo 默认启动参数。
- [TypeScript SDK](https://cursor.com/docs/sdk/typescript)：已有真正的 local 模式，支持本地会话存储和事件流，不能误认为 Cursor 只提供云端 API；但本地执行仍使用 Cursor 在线推理。当前文档说明 local 默认不限制工具执行，`autoReview` 为分类器审查而非 Namo 的确切操作授权；hooks 也有独立配置加载机制。故先选择权限交互明确的 ACP，SDK 另做受控环境试验，不同时维护两套正式 Cursor 适配器。
- [登录](https://cursor.com/docs/cli/reference/authentication)支持官方浏览器流程或 API key；[配置](https://cursor.com/docs/cli/reference/configuration)提供 `CURSOR_CONFIG_DIR`。该变量是否覆盖认证、会话、hooks、MCP 等全部状态仍需按实际版本验收。安装了 Cursor 编辑器不等于 CLI / ACP 已可用，也不代表 Namo 可以接管编辑器中的当前对话。

本轮本机仅做可执行文件发现和 `claude --version`：PATH 中发现 Claude Code 2.1.311 与 Codex，未发现 `agent` / `cursor-agent`；没有据此判断 Cursor 编辑器是否安装，没有读取登录凭据、测试认证或调用模型。以上网页能力均仍需固定 CLI / SDK 版本做协议和真实任务验收。

## 互相兼容到哪一层

| 层级 | 方案 / 边界 |
| --- | --- |
| 飞书入口、任务状态、进度、结果卡片 | 由 Namo 统一，切换 Agent 不重新配对机器人，也不新增接收端 |
| 项目文件和 Git 仓库 | 可处理同一项目；同真实目录及父子目录继续互斥，不能因为 Agent 不同就并发写入 |
| 原生协议 | app-server、Claude SDK、ACP 分别适配；同为 JSON-RPC 或 JSON 流不代表方法、事件、错误语义相同 |
| 原生 session | 不互通；以执行器、配置实例、项目、用户 / 工作线范围绑定原生 ID，禁止跨执行器解释 ID 或直接复制 session 文件 |
| 性格、偏好、记忆和交接材料 | Namo 按授权范围组装有版本的输入快照，转换后传递；不保证输出风格完全一致，不自动导入整份供应商私有记忆 |
| 项目指令 | Namo 管理共同约定；适配器明确加载原生 AGENTS.md / CLAUDE.md / Cursor rules 的范围，不复制改写用户文件制造多份真源 |
| MCP / Skills / hooks | 作为可选能力独立配置；MCP 的工具协议不等于 Agent 调度协议，配置格式、权限、hooks 和技能发现路径不能原样通用 |
| 权限与审批 | 映射 Namo 的操作要求，逐项报告可执行边界；权限回调、自动审查、提示词和操作系统隔离各自独立，不宣称完全等价 |
| 修订、等待与恢复 | 按能力选择原生 steer、下一轮追加或不支持；人工等待的持久恢复须逐后端验证，不假装所有回调都可跨进程保存 |
| 图片、产物与证据 | 保留统一输入材料与结果协议，按后端能力转换；缺少证据就显示未知，不能根据最终文字生成“测试通过”记录 |
| 模型与费用 | Agent、模型和账号配置分开；同名模型在不同产品中也不是同一个执行器。独立认证、计费与预算，不把切换 Agent 当成免费兜底 |

## 对 Namo 当前架构的具体调整

当前源码已提供 `Runtime`，但实现仍与 Codex 耦合：`src/config.ts` 仅允许 codex；`src/agents.ts` 的发现与工厂只有 Codex 可执行；`src/runner-worker.ts` 直接创建 `CodexRuntime`；`src/runner.ts` 使用 Codex 环境及记忆提取路径；`src/tasks.ts` 的权限指纹固定 agent 为 codex，工作线 session 键未包含执行器；`src/waits.ts` 绑定 thread / turn / call。不能只添加下拉选项就称多 Agent 已接入。

### 1. 注册表、配置与探针

- 引入 `AgentProfile`：稳定 id、adapter 类型、启用状态、可执行文件 / SDK 版本、官方认证引用、独立状态目录、默认模型、能力和并发 / 预算上限。允许预先配置多个 profile，只有被选中的实例运行，不常驻启动所有 Agent。
- 将项目、通用执行策略、助手与记忆从 `codex` 私有配置抽离；保留旧配置兼容读取，将现有实例映射为默认 Codex profile，保留 home、session 和历史任务，不强制重新登录。
- 探针分别显示已安装、协议可用、认证可用、策略满足和真实任务已验收。登录 / API key 仅在本机操作；付费 smoke 测试明确提示所选账号与模型，日志只记录脱敏元数据。
- 能力声明至少区分：nativeResume、cancel、revision（steer / queued-next-turn / none）、userInput（live-callback / durable-resume / none）、permissionRequest、toolEvidence、images、externalWait、memoryExtraction。声明不是验收；升级后重新检查协议和缺失字段。

### 2. 运行快照与公共事件

- runner 按任务已固定的 profile 创建适配器，而非读取“当前默认 Agent”决定旧任务去向。快照包含 adapter / 版本、profile 修订、model、项目、策略、上下文版本和所需能力；任务创建时冻结选择，启动前重核授权及能力，配置被撤销则阻止执行，不偷偷换后端。
- 用 Namo 的 run ID 作为公共执行标识，原生 session / turn / tool-call ID 放入带后端命名空间的映射；无原生 turn ID 的后端可以使用本地运行关联，但不能伪造供应商 ID。保留现有 Codex 历史映射。
- 规范化输出为活动、工具证据、用户问题、权限请求、终态和结果。模型思考、原始密钥及工具日志不进入飞书；只由接收服务投递，执行器不自行发消息。
- SDK 运行在独立 worker 进程，环境白名单按 profile 构建，不能把全部后端密钥传给一个 worker；保留接收端重启不杀运行、原进程归属、目录锁、取消与未知结果核对。
- 记忆提取也必须有明确的执行器选择：首期可继续固定现有 Codex 提取器并在 UI 披露；若用户要求全量切换，须配置并验收替代提取器或显式停用提取。不能前台选 Claude，后台却隐蔽继续消耗 Codex 额度。

### 3. 等待、权限与恢复

现有 Namo 人工等待会收口当前运行并在后续轮次恢复；Claude 的 SDK 回调和 Cursor 的阻塞扩展可能要求原进程继续存活。需要区分 `live-callback` 与可释放 worker 的 `durable-resume` 两种机制：

- 问题先落库，飞书回答关联确切用户、话题、任务、运行、问题版本与原生调用；活回调由原 worker 持有，接收端重启可重新连接，超时 / 取消明确关闭等待。
- 是否释放并发槽、是否继续占有项目锁按实际进程状态定义。首期保守保留项目锁，限制等待时长，不能在工具调用尚未收口时让另一个 Agent 修改同目录。
- worker 崩溃后，不把已存的回调请求视为可自动重发；只有验证过的原生恢复能力才能续答。否则标记需核对，必要时从已知效果生成新任务，不重放未知工具动作。
- 用户问题、工具授权和 Git push / 部署审批是不同事件；接受计划、允许一次工具不等于允许推送。不得默认响应 allow-always、开启 bypass 或用通用 shell 放行代替确切操作授权。
- 运行中补充若没有已验收的 steer，则持久化为下一轮输入并明确提示；不能通过杀掉正在写文件的任务再启动新后端实现“无缝切换”。

### 4. 切换与按任务路由

计划交互示例（尚未实现，最终命令需核对现有解析器）：`/agents` 查看可用实例，`/agent claude-main` 修改工作线后续新任务默认值，`/run --agent cursor-main ...` 为单次任务指定执行器。本机 UI 同时支持添加、探测、启停、默认实例、项目覆盖与单次选择，任务详情展示实际 Agent / model 与选择原因。

- 路由优先级：本次明确指定 → 工作线选择 → 项目默认 → 实例默认；能力 / 权限校验是硬前置，不因优先级高而跳过。未知实例、缺失认证或不支持图片 / 等待时先说明，不静默降级。
- 修改默认只影响之后创建的任务；排队、运行、等待任务都保留既有 profile。首期不实现排队任务原地换 Agent，需要改选时取消未执行任务并创建明确关联的新任务。
- 回到之前用过的 Agent，可恢复该工作线下对应的 session；还需追加其未见过的任务交接记录与当前仓库状态，不能以为旧 session 知道另一 Agent 刚完成的修改。
- 跨 Agent 延续使用交接包：目标、当前范围、决定、未解决项、来源消息、相关文件 / HEAD / 未提交变更摘要、验证证据和已知副作用。按发送到目标供应商的范围过滤并记录来源与版本；不包含密钥、思考过程、整段无关私聊或可复用的外部操作批准。
- 第一阶段先支持用户指定“这个任务用 Claude，下一个用 Cursor”。之后增加显式规则，如用户配置“review → profile A，implementation → profile B”，不预设某厂商擅长某类任务；规则记录版本、依据和缺失能力处理。
- 自动路由只在允许的 Agent 集合、预算和数据发送范围内选择。任务执行结果不明、已经改文件或调用外部工具时不能自动切换重试；认证失败等确认未开始执行的情形，也只按用户已配置的 fallback 策略处理并留痕。
- 不同项目可在全局及每 profile 限额内并发。同一项目首期仍串行；后续确需多 Agent 并行才引入隔离 worktree、共享资源约束、变更合并与复核。推送及部署继续按现有确切目标确认规则执行。

## R7 分阶段交付与验收

R7 为新增后续交付，不替换 R0–R6 的现有验收缺口，也不视为本轮实施授权。

| 子项 | 待实现范围 | 退出条件 |
| --- | --- | --- |
| R7.0 兼容性试验与契约 | 固定两种后端版本、核实官方认证与计费适用范围；临时仓库验证事件、取消、目录边界、等待和恢复；确定能力等级 | 每项有支持 / 降级 / 不支持及证据；不触及真实项目，未知权限边界不能标为可写 |
| R7.1 注册表与 Codex 兼容迁移 | 多 profile 配置、通用 runtime 工厂、任务快照、session 命名空间、能力探针、UI / CLI 选择 | 原配置无需重新登录；旧任务 / 等待 / session 能继续，数据保留；改变默认不影响既有任务 |
| R7.2 Claude 适配器 | SDK worker、官方认证、事件证据、取消、原生续接和等待桥接 | 临时仓库读写 / 测试、中文与图片能力、独立会话、接收端重启及回调丢失测试通过；不自动继承宿主 hooks / 密钥 |
| R7.3 Cursor 适配器 | ACP 握手、session、工具权限、提问、阶段与终态；SDK 仅保留对比结论 | 不依赖 `--force` 完成已授权最小闭环；未知方法、重复响应、断线与停止结果可核对；未支持能力明确拒绝 |
| R7.4 手动任务路由与交接 | 工作线 / 项目默认、每任务指定、跨 Agent 交接及返回旧 Agent 的增量同步 | 三执行器可预配置，切换不重新配对飞书；同目录不并发写；两用户 / 两话题不串上下文，实际执行器可追踪 |
| R7.5 规则路由 | 显式任务类型规则、能力匹配、预算和透明选择理由 | 能预览匹配结果；失败不盲切重放；未启用 Agent、越权项目或数据范围不会入选；不包含自动多 Agent 拆分派工 |

共同验收：分别测试全新初始化、旧配置升级、禁用 profile、过期认证、权限变化、模型不可用、重复输入、取消、等待中重启、worker 失联、投递失败、跨执行器切换和切回。API / 协议成功、实际文件效果、平台接受及用户收到分别记录；只有完成真实受控任务与飞书验收后才将该 adapter 标为可用。公开发布另行确认。
