# Claude 适配器：R7.2 隔离实验（暂停）

实验代码随分支整合保留在 main，接入开发与新增真实验证仍暂停。当前提供 `ClaudeRuntime` 和独立 SDK worker，用于临时项目的兼容性验证。生产 `runtimeFor` / 注册表仍拒绝 Claude，不修改现有 Codex 默认值、模型、登录、记忆或运行服务。它不是已可供飞书任务使用的第二执行器。

## 已实现的契约

- SDK 固定 `@anthropic-ai/claude-agent-sdk@0.3.311`，显式指定本机 Claude CLI；本轮 CLI 基线为 2.1.311。包带平台二进制依赖，体积明显增加；公开分发前仍需评估可选安装及平台验收。
- Namo 为每次 query 创建独立 worker 进程组。新会话保存原生 session ID，按同一目录、认证配置、模型与凭据摘要绑定；恢复只接受精确 ID，不使用“最近会话”。Namo 的 `claude-run:…` 是本地关联标识，不伪称供应商 turn ID。
- HOME、配置目录、临时目录与环境均隔离；SDK `settingSources: []`、空插件 / skills / MCP、禁止自动记忆、禁用 hooks，并使用 bare 模式。组织托管策略另受官方 CLI 控制，尚未完成该层真实隔离验收。
- 只转发固定工具进展、工具结果状态及最终文本；不转发思考、原始工具输出、stderr 或原始异常。凭据字面值从最终结果中移除。工具调用成功不等于项目验收成功。
- 单次权限请求以原生 tool call ID 关联本进程回调，缺省拒绝；不写持久授权或返回 always-allow。文件操作限制在临时项目，拒绝越界、符号链接及过量输入。
- 默认 `toolSet: files` 请求 Read、Edit、AskUserQuestion；运行时回报 CLI 实际公布的子集。`bounded-shell` 另请求 Bash，但仅可获批 `/bin/sleep 30`、`/usr/bin/true`、`/usr/bin/false` 三个固定测试命令。这不是通用 shell 权限或完整 OS 沙箱。
- 用户提问是有界的活进程回调，超时默认拒绝。生产 durable wait、接收端重连和跨进程回答尚未接通；传入 `onWait` 直接报未验证，不悄悄丢弃等待协议。steer 明确拒绝，图片与 PR review 桥接未开放。
- 取消 / 超时先终止进程组，最迟两秒后强制清理。结果未定、worker 崩溃和会话不匹配不会重跑或 fallback。取消仅证明本机进程结束，不证明供应商停止计费或已撤销副作用；Windows 进程组边界尚未验证，直接拒绝运行。

## 三种认证方式

`ClaudeConfig.auth` 是互斥配置，不接受混合模式：

| mode | 凭据来源 | 隔离规则 |
| --- | --- | --- |
| `official-login` | 用户在专用 profile HOME / CLAUDE_CONFIG_DIR 内自行完成的官方登录 | 不导入 router 地址、API key、AUTH_TOKEN；不复制个人认证。当前无官方账号，真实登录 / Keychain 边界未验收 |
| `official-api-key` | 明确指定的本机私有 env 文件 | 只接受独立 API key 文件；带 router 地址 / token 的混合文件直接拒绝，不继承宿主变量或 router 模型 |
| `router` | 明确指定的私有 env 文件及 `baseUrl` | URL 须与文件完全一致，限 HTTPS 且无用户信息、query、fragment；只提取四个 ANTHROPIC 白名单变量，无自动 fallback |

每个 HOME 首次使用时固定认证模式与 router 地址，后续更换模式须用独立 HOME，防止误用已有本地状态。env 文件要求属于当前用户、POSIX 权限不向组 / 其他用户开放且不是符号链接。只解析双引号字面量赋值，不 source、不展开 `$`、反引号或反斜杠，不执行其他行。配置保存路径引用，密钥不进仓库、命令参数和报告。

官方账号、官方 API key 和 router 共用执行契约，彼此独立验收。Kaon 的结果不提高官方路线状态。个人专用登录与公开产品提供 claude.ai 登录入口不同；公开版提供订阅登录仍按 [SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)核实所需批准，API key 为默认公开集成路线。[官方订阅使用说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)不视为通用分发许可。

## 手动运行隔离验证

先构建，再显式使用 `--live`；会调用所选账号 / 路由并使用额度。脚本只创建临时项目和临时 HOME，不连接飞书或读取 bot 数据库：

```sh
pnpm run build:server
node dist/scripts/smoke-claude.js --live --auth router --bin /absolute/path/to/claude --env-file /absolute/private/credentials.env
```

官方 API key 改为 `--auth official-api-key`；官方专用登录使用 `--auth official-login --profile-home /absolute/dedicated/home`，没有登录时不从个人配置补齐。未给 profile-home 时新建临时 HOME，不能据此推断已有个人账号是否可用。`--tools-only` 只跑文件权限与取消组；`--report` 保存纯状态报告。完整验证有未通过或未验证项时退出码为 2，准备失败为 1；只有本次所选测试组的全部必需断言通过才返回 0，不把“脚本结束”视为通过。默认删除临时测试目录；`--keep` 可保留本机私有诊断文件，可能含临时对话，不得提交或打印原始日志。

## 开放生产前的剩余门槛

1. 当前 Kaon 模型的稳定精确恢复，以及 Read/Edit 的允许与拒绝实效。
2. 固定版本实际公布的工具集。CLI 未公布 Write / AskUserQuestion 时不能宣称这两种原生能力支持；需要另行验证受控 MCP 用户提问桥或其他官方能力。
3. 真实工具执行中取消、用户提问、重复回答、超时、接收端重启 / worker 丢失及人工核对；稳定地对接 Namo 等待账本和项目锁。
4. 通用项目写入 / 命令沙箱与授权、官方认证、图片 / 外部工具、原生配置读取范围和公开分发方式。

任何门槛没过都保留明确的不可用状态；不能通过关闭权限检查、复制个人配置、自动替换模型或切换路由来完成验收。
