# 从 OpenClaw 迁移

更新：2026-10-26。对应[主计划](development-plan.md)的 R2。安全迁移内核已经实现；`namo init` 的交互入口由主流程接入，真实接管仍需要用户在本机按下面的手动门槛操作。

## 已核验的输入边界

实现依据是 OpenClaw 官方的 [`config` 文档](https://docs.openclaw.ai/cli/config)、[迁移说明](https://docs.openclaw.ai/install/migrating)、[Feishu 配置参考](https://docs.openclaw.ai/channels/feishu/configuration-reference)，以及本机已安装 OpenClaw 包的只读元数据和随包文档。核验时安装包版本为 `2026.10.6`；未读取 `~/.openclaw`、凭据库、运行状态或服务配置。

首版故意只接受以下来源，条件不满足时不猜字段：

- 用户明确选择的单个普通文件，不接受符号链接、目录或超过 2 MiB 的输入；
- 标准 JSON 编码的 `openclaw.json`，不在 Namo 内实现宽松 JSON5 求值；
- `meta.lastTouchedVersion` 必须精确等于已核验的 `2026.10.6`；
- `channels.feishu` 下必须能解析出明确的应用，用户必须明确选择来源实例 ID 和 account ID，即使只有一个应用；
- 仅支持 `feishu` / `lark` 域及 `websocket` / `webhook` 接入标记。Webhook 凭据可导入，但必须在飞书后台人工切换为 Namo 使用的长连接事件接入，并停用旧回调/反向代理入口；
- App Secret 只支持来源 JSON 中的直接字符串。OpenClaw SecretRef、环境引用或缺失凭据不会被解析、打印或继承，导入报告只标记“需要补齐”。

JSON5、未知版本、不可读来源、非标准域或接入模式都会返回结构化的不支持/人工处理原因，原文件和目标配置保持不变。旧版本应先按其对应版本的 OpenClaw doctor 与已验证备份流程升级/规范化，再重新生成预览；Namo 不负责修复 OpenClaw 内部格式。

## 已实现能力

`src/migration.ts` 提供以下纯本地 API，供 `init` / 管理界面接入：

- `inspectOpenClawSource`：只读兼容检查和多应用枚举；结果只有版本、数量、脱敏尾缀、SHA-256 指纹、候选文件名/大小等元数据，不含 App ID、App Secret、候选正文或来源中的其他配置值。
- `previewOpenClawMigration`：要求显式来源与 account ID，生成字段冲突、凭据状态、权限数量、通配授权风险、工作区可用性和排除项清单。已有配置的 App ID、App Secret/环境引用、域或项目名冲突必须逐项选择 `keep-target` / `use-source`。
- `readOpenClawCandidate`：只有用户点选具体候选后才读取正文；导入时再次核对候选指纹，预览后发生变化必须重新审阅。
- `importOpenClawMigration`：重新核对来源与目标指纹，使用 `ConfigEditor` 做并发保护、原配置私有备份和 0600 原子写入。写入前保存 `writing` 检查点，写入后核对目标指纹；重复执行返回已导入，进程在配置写入后中断可安全补记完成状态。
- `beginCutover` / `completeCutover`、`beginRollback` / `completeRollback`：只记录受保护的迁移状态，不启停服务。状态转换要求精确 migration ID、应用指纹、应用专属确认短语、五分钟内的双端接收器证据；接管完成还要求同一应用真实飞书入站、回复送达及用户确认。

迁移记录和待审阅材料位于目标 `dataDir/migrations/openclaw/<migration-id>/`，目录按 0700、文件按 0600 创建。记录只保存来源/目标指纹、版本、选择项、状态与材料路径，不保存报告可见的凭据值。

## 字段与权限策略

直接转换的字段只有：所选应用的 App ID、可直接读取的 App Secret、Feishu/Lark 域。Namo 继续使用官方 Codex 执行器；新配置固定从 `sandbox: read-only`、`networkAccess: false`、`allowLocalCommits: false` 开始。

权限默认不扩大：

- 新配置的 `allowedUserIds`、`allowedChatIds` 默认都为空，`requireMention` 默认 `true`；
- 只有显式选择 `use-source` 才导入来源白名单；`"*"` 和通配 group 永远丢弃；
- 只有显式选择 `mention: use-source` 才允许沿用来源的 `requireMention: false`；
- 工作区只有在路径可解析为具体目录、用户明确选择导入且项目名合法时才加入 `codex.projects`；不扫描整个工作区。

`SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md`、`AGENTS.md` 只作为“待审阅材料”发现。只有明确批准的候选会复制进私有 review 目录，状态仍是 `pending-review`，不会自动注入 Agent、变成全局记忆或执行其中指令。身份/用户归属不明的材料同样不会自动生效。

以下内容无条件排除：OpenClaw 模型/渠道授权、Gateway 设置、插件或可执行代码、待执行任务、cron、session、聊天历史、模型提供商及登录凭据。历史摘要不伪装成可续接的 Codex session。

## 接管与回退的人工门槛

OpenClaw 公开资料没有提供可由 Namo 安全调用、且能按单个 Feishu 应用原子切换接收器的稳定跨产品控制协议。尤其是 Webhook 回调仍在飞书后台或外部反向代理中，OpenClaw Gateway 也可能承载其他账号/渠道。因此首版**不支持自动停用、修改或恢复 OpenClaw 服务**，也不会运行第二个同应用接收器来“试试看”。

接管必须按应用执行：

1. 核对预览中的应用指纹，处理或明确对账该应用的在途工作。
2. 用 OpenClaw 原生命令/运维方式只停用所选应用接收入口；Webhook 模式还要在飞书后台把该应用改为长连接事件接入，并停用旧回调/反向代理入口。Namo 不接收 OpenClaw Webhook，不得把回调地址改指向 Namo，也不得顺带停止其他机器人或渠道。
3. 提供同一应用的 OpenClaw inactive 与 Namo inactive 新鲜证据，输入 `CUTOVER <应用指纹前 12 位>`，状态才进入 `cutover_pending`。
4. 启动 Namo 后再次确认 OpenClaw inactive、Namo active，并完成真实飞书入站、回复送达及用户确认，状态才进入 `cutover_verified`。进程存在、健康检查或 HTTP 200 单独都不算迁移验收成功。

回退顺序相反：先停 Namo 并证明 Namo 与 OpenClaw 均 inactive，输入 `ROLLBACK <应用指纹前 12 位>`；再恢复来源并证明 OpenClaw active、Namo inactive。回退不删除迁移期间产生的 Namo 数据，不重放含糊任务，不覆盖数据库。切换窗口可能漏收消息，不能承诺飞书自动补发。

向用户展示接管确认时必须保留以下提醒：

> 确认切换后，这个飞书机器人将由 Namo 接收消息并调用已配置的 Agent 处理，OpenClaw 将不再处理该机器人的新消息。机器人应用保持不变，但命令、能力和权限按 Namo 的配置生效。未迁移或尚未生效的记忆与功能已在清单中列出。切换期间可能短暂无法响应；请确认后再接管。

## 验证覆盖

`test/migration.test.ts` 覆盖：标准格式与精确版本、多应用显式选择、元数据报告不泄密、JSON5/旧版拒绝、全新与已有 Namo 配置、逐项冲突、ConfigEditor 备份、默认收紧权限、通配授权丢弃、工作区显式导入、候选审阅后变更、SecretRef 人工补齐、来源/目标指纹变化、重复导入、中断后恢复，以及接管/回退的确认、时效、单接收器与真实收发证据门槛。

本模块测试只使用临时 fixture，不触碰真实 OpenClaw 配置、凭据、进程或服务。
