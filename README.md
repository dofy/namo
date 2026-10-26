<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — an orange fox with a curled tail" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>住在本地，帮你把事情做完的小狐狸。</strong><br />
A local-first coding agent gateway.</p>

Namo 将聊天应用连接到本地开发环境。首期支持 **飞书 / Lark + Codex app-server**：从私聊或群 @ 发起任务，在指定项目中修改代码、运行命令和测试，再将结果回复到原会话。

Namo 管理消息、队列、项目、会话和执行边界；任务理解与工具执行交给官方 Codex。代码、执行环境和任务状态位于本机，模型推理使用 Codex 账号对应的服务。

**状态：早期可用版本。** 面向个人或少量可信用户，已验证真实飞书收发及本地开发流程，仍需自行维护运行主机。

## 已有能力

- **聊天入口**：飞书长连接，支持私聊、群 @、文字及基本富文本；通过用户白名单限制访问。
- **项目与会话**：绑定已配置的本地项目，按会话保存 Codex 上下文，支持查看状态、取消请求和重置。
- **可靠执行**：SQLite 持久化入站与出站，消息去重，同会话串行，可配置全局并发。
- **明确恢复**：排队任务可恢复；执行中断或发送结果不明时保留记录，不盲目重跑或重发。
- **开发权限**：可配置项目内读写、命令联网及本地 Git 提交；配置模板默认只读。
- **本地常驻**：单实例锁、配置检查、协议 smoke，以及 macOS launchd 安装脚本。

当前不包含图片 / 文件 / 语音解析、流式卡片、定时提醒、后台派工或离线历史消息补拉。

## 快速开始

需要 Node.js **24.15+**、pnpm **12.15.0**、已安装的官方 Codex CLI，以及具备机器人能力的飞书自建应用。当前实现已在 Codex CLI **0.154.0** 上验证；升级后应重跑协议及权限检查。包管理器版本由 `packageManager` 固定，依赖以 `pnpm-lock.yaml` 为准。

```sh
git clone git@github.com:dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
# 仅在首次配置时执行，已有文件请勿覆盖
cp config.example.json config.local.json
chmod 600 config.local.json
```

编辑 `config.local.json`，至少填写 `feishu.appId`、`feishu.appSecret` 和 `feishu.allowedUserIds`。用户 ID 使用 `open_id`，空名单拒绝所有人。也可以通过 `appSecretEnv` 指向的环境变量提供 Secret。

在飞书平台启用机器人、长连接事件订阅及消息接收 / 发送权限，订阅 `im.message.receive_v1` 并发布应用。如复用已有 bot，先停用旧接收端，避免同一应用的多个连接分流事件。

```sh
# 使用独立的 data/codex-home 完成官方登录
pnpm run login
pnpm run check
pnpm run smoke:codex
pnpm start
```

看到 `ready` 后私聊机器人；群里需要 @ bot。真实模型 smoke 可运行 `pnpm run smoke:codex -- --run`，会使用账号额度。

## 在项目中工作

配置模板默认使用只读的隔离会话目录。要对真实项目进行开发，将下面字段**合并**进本地配置，并替换项目路径：

```json
{
  "concurrency": 1,
  "codex": {
    "sandbox": "workspace-write",
    "projects": { "app": "/absolute/path/to/project" },
    "defaultProject": "app",
    "networkAccess": true,
    "allowLocalCommits": true
  }
}
```

项目目录必须已存在。Homebrew 等位于系统默认范围外的工具链，可能需要通过 `codex.readPaths` 显式授权读取；不要为此放开整个个人目录。Git 使用仓库局部作者配置，不加载个人全局 / 系统配置；需要时先在目标仓库配置 `user.name` 和 `user.email`。

| 命令 | 作用 |
| --- | --- |
| `/project` | 查看目录与可选项目；`/project app` 切换并开始新上下文 |
| `/status` | 查看队列、目录与权限状态 |
| `/cancel` | 停止本会话正在执行和排队的请求 |
| `/reset` | 开始新的 Codex 上下文，保留代码和文件 |
| `/whoami` | 查看当前飞书用户及会话 ID |
| `/help` | 查看支持的功能和命令 |

## 权限与运行边界

- 工具按当前项目和显式配置的路径授权；bot 配置、运行数据及独立 Codex 登录目录自动排除。
- 项目写权限也允许修改或删除普通文件。取消、超时或重置不会撤销已经发生的操作。
- 本地修改、测试和提交可以直接执行；**推送和部署必须先说明目标与内容，等待用户确认**。当前这项确认由 bot 指令约束，尚无命令级强制审批拦截。
- 出站 `sent` 回执表示平台已接受创建消息，不代表用户已读。发送结果不明会单独记账。
- Mac 休眠或断网时无法持续提供服务。本版本没有历史消息补拉，不能保证离线期间所有消息都能恢复。
- `config.local.json`、`data/`、日志和认证文件属于私有数据，禁止提交。独立 Codex 环境不自动接入个人 MCP、插件或第三方模型网关。

## 常驻与开发

```sh
# macOS：安装或卸载自动启动，保留配置和数据
pnpm run service:install
pnpm run service:uninstall

# 本地状态和验证
pnpm run status
pnpm test
```

自动启动不会继承终端中临时导出的 Secret。现有服务更新代码或配置后，先编译，再卸载并重新安装服务；不要删除 `data/`。

技术栈：TypeScript、Node.js 内置 SQLite、飞书官方 Node SDK、Codex app-server（stdio JSON-RPC）。测试覆盖真实 SQLite 与子进程协议，以及去重、并发、恢复、取消和发送异常。

更多说明：[配置与运维](docs/operations.md) · [品牌与 Logo](docs/brand.md)

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server) · [飞书官方 Node SDK](https://github.com/larksuite/node-sdk)
