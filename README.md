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

- **聊天入口**：飞书长连接，支持私聊、群 @、文字及基本富文本；通过一次性本地配对和用户白名单限制访问。
- **项目与会话**：绑定已配置项目，按聊天话题和用户管理工作线与 Codex session，支持新建、查询和显式续接。
- **消息与任务**：稳定任务编号；指令、材料和修订分别落库，排队补充合并，运行补充走 Codex 原生追加协议。
- **可靠执行**：SQLite 持久化入站与出站，消息去重，同聊天及同项目目录串行，可配置全局并发。
- **明确恢复**：排队任务可恢复；执行中断或发送结果不明时保留记录，不盲目重跑或重发。
- **本地工作台**：`namo ui` 查看任务、运行和投递记录，修改项目与权限，诊断连接，逐项核对异常。
- **可选任务卡片**：固定接收 / 结果卡片，支持查看状态与停止；默认仍发文本，按钮需配置飞书回调。
- **开发权限**：可配置项目内读写、命令联网及本地 Git 提交；配置模板默认只读。
- **本地常驻**：单实例锁、分层 doctor、协议 smoke，以及 macOS 后台服务安装、启停和卸载。

当前不包含图片 / 文件 / 语音解析、流式卡片、定时提醒、后台派工或离线历史消息补拉。

M1 已完成现有安装的升级与核心私聊验收，见 [验收记录](docs/m1-verification.md)。其他已有常驻服务不会因代码编译自动切换；消息升级、维护窗口与回退限制见 [架构说明](docs/architecture.md) 和 [配置与运维](docs/operations.md)。

M1 异常核对与 M2 第一批已完成本地实现和隔离验证，尚未切换在线接收服务；真实卡片回调与配置应用仍待验收，见 [M2 验收记录](docs/m2-verification.md)。

## 安装与初始化

当前为发布前验收版，**尚未发布 npm**，正式发布需要所有者确认。已提供包含编译产物的 CLI tarball，无需用户克隆源码或安装 pnpm：

```sh
npm install -g ./namo-0.1.0.tgz
namo init
```

需要 Node.js **24.15+** 和官方 Codex CLI。向导会完成 Agent 探测、独立登录、项目权限选择、飞书配置、一次性配对，以及可选的真实模型收发验证；可中断后继续，不要求手工查询 open_id 或编辑 JSON。

完整步骤：[安装与第一次使用](docs/getting-started.md)。已有配置可以显式指定 `--config`，当前目录的旧 `config.local.json` 也继续兼容；配置与数据不会自动移动或覆盖。

```sh
namo --help
namo agent list
namo doctor           # 不调用模型
namo doctor --live    # 明确进行真实模型测试，可能使用账号额度
namo status
namo logs
namo ui               # 本机工作台，不启动另一接收端
namo issues           # 异常核对列表（需要 schema 2）
```

首版后台服务管理支持 macOS，其他系统可前台运行但尚未完整验收。Codex 协议基线为 **0.154.0**；CLI 版本变化后会重新探测协议与权限配置，不会自动放宽沙箱。Claude Code 和 OpenClaw Gateway 仅显示发现状态，尚未实现接入。

源码开发继续使用 pnpm **12.15.0**，依赖以 `pnpm-lock.yaml` 为准：

本地工作台使用 **React + TypeScript + Radix Themes**，由 **Vite** 构建。静态资源随 CLI 分发，仍通过 `namo ui` 打开，无需另装前端服务。开发方式见[安装与使用](docs/getting-started.md#前端开发)。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm cli --help
pnpm cli init
pnpm test
```

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
| `/tasks`、`/task N-编号` | 查看本人在本聊天的近期任务、执行状态、修订与投递状态 |
| `/issues`、`/issue 编号` | 查看本人、本聊天的异常及核对指引；按返回的 `/resolve` 命令处理，不重跑模型 |
| `/material 内容` | 暂存材料，10 分钟等待处理说明；过期不自动执行 |
| `/run 处理要求` | 开工并关联同用户、话题和项目的待处理材料；普通文字也可直接开工 |
| `/amend N-编号 补充` | 追加到原任务；引用本人任务消息也可追加，已结束的任务会创建后续任务 |
| `/cancel [N-编号]` | 停止本人、本聊天的指定任务；无编号仅取消当前话题的本人任务 |
| `/session [W-编号]` | 查看或选择本人在本聊天的工作线，续接其 Agent 上下文 |
| `/new`、`/reset` | 开始新的工作线上下文，保留历史任务、代码和文件 |
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

自动启动不会继承终端中临时导出的 Secret。配置可在 `namo ui` 中保存，再单独确认应用；仅支持兼容新版服务且队列空闲。旧服务升级须安排维护窗口与备份，见运维说明；不要删除 `data/`。

技术栈：TypeScript、Node.js 内置 SQLite、飞书官方 Node SDK、Codex app-server（stdio JSON-RPC）。测试覆盖真实 SQLite 与子进程协议，以及去重、并发、恢复、取消和发送异常。

更多说明：[首次使用](docs/getting-started.md) · [配置与运维](docs/operations.md) · [品牌与 Logo](docs/brand.md)

设计与进度：[架构说明](docs/architecture.md) · [开发计划](docs/development-plan.md)。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server) · [飞书官方 Node SDK](https://github.com/larksuite/node-sdk)
