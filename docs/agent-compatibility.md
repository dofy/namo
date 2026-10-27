# Agent 兼容性基线

核验日期：2026-10-27。本文记录 R7.0 的分层兼容性试验，并为 R7.1 注册表提供探针语义。`supported` 只表示表中写明的那一层有直接证据；它不会自动把认证、会话、推理、权限回调或真实文件效果也标成成功。

## 固定版本与官方来源

| 组件 | 固定版本 | 官方来源 | 本轮证据 |
| --- | --- | --- | --- |
| Claude Code CLI | `2.1.311` | [Claude Code](https://github.com/anthropics/claude-code)；[程序化 CLI 文档](https://code.claude.com/docs/en/headless) | 宿主 `~/.local/bin/claude` 的真实目标为官方版本目录；`--version` 成功 |
| Claude Agent SDK (TypeScript) | `0.3.311` | npm `@anthropic-ai/claude-agent-sdk`；[Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)；[官方 SDK 仓库](https://github.com/anthropics/claude-agent-sdk-typescript) | 仅在临时隔离目录以精确版本、禁用 lifecycle scripts 安装并核对 package name/version；不是项目依赖；随后只在用户单独授权的 Kaon 附加基线中调用 `query()`，见下文 |
| Cursor Agent CLI | `2026.10.22-27dcf5f` | [官方安装说明](https://cursor.com/docs/cli/installation)；[ACP 文档](https://cursor.com/docs/cli/acp) | 下载并先检查 `https://cursor.com/install`，安装器 SHA-256 为 `77d44de2cb8d12245077e290870ca4085644c5cfd534ba96334c4d6eeb8f0a7c`；只安装到临时 HOME，实际下载地址位于官方 `downloads.cursor.com`；宿主 PATH 未安装 |

Cursor 安装器和下载版本会更新；上面的 hash 是这次取样的证据，不是永久 allowlist。升级时必须重新获取官方安装说明、固定实际版本并重跑协议探针，不能只信任名为 `agent` 的通用可执行文件。

## 状态语义

探针分别返回 `installed`、`protocol`、`auth`，三者不可互相推导：

- `supported`：当前检查项有直接、可重复的本地证据。
- `unverified`：文档或命令表面存在，但本轮未跨过真实协议/账号/效果边界，或有界探针超时、超量、无法确认身份。
- `unavailable`：当前环境明确缺少该项，或协议响应明确无效。未登录属于 `auth=unavailable`，不是“可用但未测试”。

能力项沿用同样三态。fixture 只证明 Namo 的解析、超时和降级逻辑，不能证明供应商当前版本真正支持该能力。

## 本机与隔离试验结果

| 后端 | installed | protocol | auth | 解释 |
| --- | --- | --- | --- | --- |
| Claude CLI 2.1.311 | supported | unverified | unavailable | `--help` 具备 `--print`、stream JSON 输入/输出、resume 和 permission mode 参数，但没有在未登录状态发送 prompt；专用 profile 的 `auth status --json` 明确为未登录，用户当前没有官方 Claude 账号 |
| Claude Agent SDK 0.3.311 | supported（临时包身份） | unverified（官方路线） | unavailable（官方路线） | 官方包身份与版本已核对；无官方账号，官方 provider 下未执行 query；用户授权的 Kaon `query()` / session / abort 结果单列，不提升官方状态 |
| Cursor（宿主 PATH） | unavailable | unavailable | unavailable | 未发现 `agent` 或 `cursor-agent`，未把 Cursor 编辑器安装等同于 CLI 可用 |
| Cursor 2026.10.22-27dcf5f（临时 HOME） | supported | supported（仅 initialize） | unavailable | ACP stdio JSON-RPC `initialize` 返回 protocolVersion 1、`cursor_login` 和 `loadSession=true`；`status` 明确未认证；专用 CLI 浏览器登录的 macOS Keychain 保存失败（根因未定位），未删除或复用 Cursor app 凭据；未调用 authenticate/session/new/session/prompt |

Claude 官方文档说明 Agent SDK 由调用方运行 Claude Code agent loop，并提供 sessions、permissions 和 hooks。[Claude 方案使用说明（2026-10-07 更新）](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)说明：用户以自己的 Claude 方案登录时，Agent SDK 和 `claude -p` 消耗订阅额度；关联 Console 组织的 API key 走另一条额度路径。但 [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)仍明确第三方开发者若要向其产品用户提供 claude.ai 登录或额度，通常需要事先批准。两者适用范围不同：本机用户自己运行的专用登录可以受控验证，公开产品不能据此普遍代办登录。Namo 也不能因为宿主装有 Claude CLI 就复制或继承个人认证。

Cursor 官方 ACP 文档规定 stdio、换行分隔 JSON-RPC 2.0、`initialize`、`authenticate`、`session/new`、`session/load`、`session/prompt`、`session/cancel` 和 `session/request_permission`。本轮只直接走到 `initialize`；其余方法仍需专用登录后的受控验收。[Cursor ACP](https://cursor.com/docs/cli/acp)

### 第三方 Kaon 路线附加基线

经用户单独授权，本轮也用 Claude CLI 2.1.311 / Agent SDK 0.3.311 对现有 Kaon AI router 做了隔离、少量真实推理。它不是官方 Anthropic 认证或额度验收，不能把下列结果写成 `auth=supported`，也不能成为失败时自动切换的 fallback。

- source of truth 是权限 `0600` 的本机 shell env 文件；测试脚本不 `source` 它，只解析四个无 expansion 的双引号字面量：`ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`。URL 只允许已核对的本机配置中的 HTTPS 主机，key 与 model 未打印或写入仓库。
- 子进程使用新的 `claude-kaon-home` / `claude-kaon-config`、`--bare`、`settingSources: []`、空 plugins / skills / MCP、空工具集和精确 env allowlist；没有继承个人 hooks、rules、MCP、第三方 gateway 之外的 provider 变量或 fallback。
- 最小模型回复成功；观察到原生 session ID，并以该精确 ID resume 后正确取回前一轮 nonce。第三方 route 的 `sessionNew` / `sessionLoad` 因而有直接证据。
- 在 SDK 发出 system 初始化后立即触发 `AbortController`：iterator 拒绝、没有 result，2.119 秒内结束。它证明 owned SDK query 可有界取消，不证明远端已停止生成或计费，因为没有 provider cancel receipt。
- 等待 partial stream 再取消的试验没有收到 `stream_event`，清理超过 10 秒，不能把 partial streaming / 远端 cancel 标为支持。
- 两次明确要求 Write 的权限试验都没有产生 `tool_use`，`canUseTool` 从未触发；模型以文本收口且临时目录无文件。故 `permissionRequest` 仍是 `unverified`，不能由“没有副作用”反推权限桥已工作。

## 能力边界

| 能力 | Claude 2.1.311 / SDK 0.3.311 | Cursor 2026.10.22-27dcf5f | 退出 R7.0 前仍需的真实证据 |
| --- | --- | --- | --- |
| 新建 session | unverified | unverified | 专用账号下取得原生 session ID，确认与 Namo run ID 分离 |
| 精确恢复 session | unverified；官方 SDK 文档有 `resume` | unverified；initialize 宣告 `loadSession=true` | 进程重启后按精确 ID 恢复，不使用“当前目录最近会话”代替 |
| cancel | unverified | unverified | 任务中取消，确认进程、工具动作和终态；不能只看到客户端返回 |
| 运行中 revision | unverified | unavailable | 区分原生 steer、排入下一轮和拒绝；Cursor ACP 文档没有 Codex `turn/steer` 等价物 |
| 用户提问 | unverified（SDK `canUseTool` / `AskUserQuestion`） | unverified（`cursor/ask_question`） | 问题版本、回答归属、超时、取消、接收端重启 |
| 工具权限 | unverified | unverified | allow-once / reject、自动放行绕过边界、精确操作证据；不测试 allow-always |
| 外部等待 / durable resume | unavailable | unavailable | 证明回调是否能释放 worker 并跨进程恢复；未证明前保留锁并限制等待 |

Claude 的回调会在进程内暂停；官方文档另给出 defer 后退出再从持久 session 恢复的设计，但这不是自动成立的 durable wait。[审批与用户输入](https://code.claude.com/docs/en/agent-sdk/user-input) 说明自动批准工具不会经过 `canUseTool`，所以该回调不能当成覆盖所有工具的安全拦截器。session 只持久化对话，不代表文件系统回滚。[Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

## 安全探针契约

`src/agent-probes.ts` 只做以下动作：

- 不经过 shell，先解析真实可执行文件并以版本格式核对身份；通用 `agent` 返回普通 semver 不会被当作 Cursor。
- 所有子进程都有 50 ms–30 s 的硬超时和 1 KiB–1 MiB 的 stdout+stderr 总量上限；默认 5 s / 64 KiB。POSIX 上以独立进程组启动并对整个 group 发 SIGKILL，另有 250 ms settle fallback，避免 wrapper 的后代持有 stdio 导致永久等待。Windows 目前只能 kill 直接 child，报告 `processCleanup=unverified/windows_child_only_cleanup`，不得宣称进程树已清理。
- 子进程环境只允许 PATH、locale、临时目录及基本平台变量；HOME 只接受显式 profile 参数。未明确同时传入专用 HOME 与配置目录时，版本 / 协议检查使用临时 HOME，认证检查直接返回 `dedicated_profile_not_selected`，不会探测个人 HOME。不会传递 API key、token、代理、第三方 endpoint 或任意调用方环境变量。
- stderr 只计数，不返回内容。stdout 只提取版本、布尔认证状态、固定协议字段和 capability booleans；原始账号信息、错误文本和日志不会进入报告。
- Claude 认证检查调用官方 `auth status --json`，只读取 `loggedIn`。不会读取、复制或打印认证文件。
- Cursor ACP 初始化使用新的临时 HOME、临时 `CURSOR_CONFIG_DIR` 和临时 cwd；client capabilities 明确关闭 filesystem 与 terminal。它不执行 authenticate、session/new 或 prompt。
- `scripts/smoke-agents.ts` 输出 `inferenceAttempted: false`。需要精确 SDK manifest 时显式传 `--claude-sdk-package-json`，不会动态 import 或执行 SDK。

真实 Kaon 验证脚本只在本轮从标准输入临时执行，并在结束后删除临时仓库与临时 SDK 安装；没有进入项目脚本。`smoke-agents.ts` 继续保持无推理、无 secret 参数的静态探针，避免普通诊断误用额度或把 key 放入 argv。要重跑附加基线，应在用户明确授权的路由与用量范围内，从 0600 source of truth 在进程内解析白名单字段，使用相同的隔离选项和稳定布尔断言；禁止把 key 拼进命令、日志或 fixture。

fixture 测试覆盖：已安装但未登录、SDK package identity、ACP initialize 与 advertised loadSession、缺失二进制、版本超时、合并输出超量、畸形 JSON、通用 `agent` 身份拒绝、Claude 身份失败后不执行 auth、stdin 提前关闭不会产生未处理 EPIPE、POSIX wrapper 后代持有 stdio 时仍有界清理，以及敏感环境变量不会传给子进程。fixture 名称和响应都不进入 live evidence。

## 后续真实验收

当前没有 dedicated official login，因此官方路线仍不能完成有费用的最小推理或 session/取消/权限/等待测试。上面的 Kaon 结果只作为用户授权的 third-party-route baseline。Cursor CLI 的官方浏览器登录即使设置独立 HOME 与 `CURSOR_CONFIG_DIR`，仍尝试写固定的 macOS Keychain service/account，并以 security exit code 152 保存失败；CLI 将条目描述为 stuck，根因尚未定位，不能据此断言是重复条目冲突；浏览器随后显示完成，但专用 CLI `status` 仍明确未认证。官方 CLI 建议删除该共享项，但这可能影响已登录的 Cursor app，因此本轮明确不执行。继续时不能复制宿主凭据，也不能默认切换第三方 gateway：

1. Claude：按届时官方集成政策为 Namo 配置官方 API key 或获得明确允许的登录方式；固定 CLI/SDK 版本与独立状态目录。
2. Cursor：保留目标独立 HOME / `CURSOR_CONFIG_DIR` 与固定官方 Agent CLI；要么由用户明确接受共享 Keychain 影响后再排查保存失败，要么为该 profile 通过安全环境注入专用官方 API key / auth token。密钥不得进入聊天、仓库或探针输出。
3. 在一次性临时 Git 仓库中依次验证只读 prompt、需授权写入、拒绝、取消、精确 resume、进程中断、问题等待和重启边界；每次记录协议接受、实际文件效果、终态和费用元数据。
4. 真实任务闭环完成前，注册表可以显示 profile 和上述三态探针，但不得把 Claude 或 Cursor adapter 标为可用，也不得自动路由或 fallback。

## R7.0 退出结论

R7.0 **未全通过**。当前可以合入 R7.1 的仅是安全探针、版本固定、Cursor ACP initialize 证据，以及明确标注为 third-party-only 的 Kaon session / bounded local cancel 证据。以下项目是启用 R7.2 / R7.3 adapter 之前的阻断门槛：

- Claude 官方认证与官方 provider query 尚未验证；Kaon 不能成为发布默认或失败 fallback。
- Claude Kaon 的工具调用没有发生，因此 permission request / allow-once / reject-once、工具证据和实际写入效果均未验证。
- Cursor 没有专用认证；浏览器完成不能覆盖 CLI Keychain 保存失败，ACP session/new/load/prompt/cancel/request_permission 均未实测。
- 两后端都没有验证用户提问、计划确认、live callback 与 durable resume 的转换；没有验证等待中 receiver/worker 重启、超时、重复回答或崩溃后的副作用核对。
- 两后端都没有 provider 侧 cancel receipt；Claude 的 bounded abort 只证明 SDK iterator 与 owned process 有界结束。适配器必须明确披露这种能力限制，不能声称远端已停止计费或副作用已撤销；不要求虚构供应商未提供的 receipt。

在这些门槛完成前，注册表能力应保持 `unverified` / `unavailable`，runtime factory 应拒绝启动对应 adapter，而不是根据文档、initialize advertisement、fixture 或第三方会话成功自动放宽。
