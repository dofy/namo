<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — 一只蜷着尾巴的橙色狐狸" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>住在本地，帮你把事情做完的小狐狸。</strong><br />
面向飞书与 Lark 组织、由 Codex 驱动的自托管 Agent 服务。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">问题反馈</a> · <a href="docs/development-plan.md">开发计划</a></p>

Namo 将组织内的聊天连接到运行在工作站或服务器上的 Agent。从私聊或群 @ 发起任务，在指定项目中修改文件、运行命令和测试，再将结果回复到原会话。

Namo 管理消息、队列、项目、会话和执行边界；任务理解与工具执行交给官方 **Codex app-server**。代码、任务状态和执行环境位于本机，模型推理使用 Codex 账号对应的服务。

**状态：早期可用版本。** 支持组织接入、明确的项目授权和 GitHub 账号访问配置，已验证真实飞书收发，运行主机仍需自行维护。尚未发布 npm 包。

## 已有能力

- **飞书 / Lark 入口**：长连接、私聊、群 @、文字与基本富文本；按组织身份或指定成员名单接入。
- **组织接入**：从飞书应用检测组织身份，成员无需逐人配对；本机项目按组织、群或成员私聊授权，成员默认进入隔离工作区。
- **群聊 PR 审查**：通过服务端 GitHub 连接读取固定 base/head 的有界补丁，在获授权会话中回复发现和覆盖限制，不自动发布 GitHub 评论。
- **项目与会话**：在指定目录工作，保留会话上下文，切换项目并显式续接历史会话。
- **持久化任务**：SQLite 入站与出站、消息去重、输入修订、同聊天及同项目串行，以及全局并发限制。
- **提问与回答**：Agent 可暂停等待补充；引用问题回复，或点击与问题对应的选项按钮后继续。
- **独立运行进程**：任务与接收服务分别运行；中断或结果不明时保留记录供核对，不盲目重跑。
- **执行证据**：文件补丁、命令退出码、产物检查和 Git HEAD 快照，并明确采集范围与限制。
- **助手与范围记忆**：可选启用的助手身份和风格，带来源、范围及隐私控制的自动长期记忆，显式纠正、停用、删除及有界交接。记忆不提供操作授权。
- **材料与产物**：有界读取合并转发文字和直接发送的 UTF-8 文本文件；经授权交付指定任务文件。直接发送的 PNG/JPEG 图片会以有界、不可变的图片输入交给 Codex。
- **本地工作台**：Dashboard、任务和会话搜索、用户 / 项目 / 状态 / 日期筛选、分页、详情、用户档案、助手设置、迁移记忆审阅、配置与连接诊断。
- **简洁聊天回复**：持久化受理表情、原消息 / 话题回复、安全富文本和一张可更新的进度卡片。按钮需配置飞书回调。
- **受控继续执行**：固定 HEAD 的 GitHub 检查（公开仓库或显式配置的私有仓库）可在不让模型轮询的情况下恢复原任务；有限保护的 Git push 审批将一次批准绑定到一个任务、提交、远端和分支。
- **远程 MCP**：显式添加公网 HTTPS 连接并限定使用范围；工具调用在飞书中逐次审批，支持 OAuth 或 Bearer 授权。
- **本地服务管理**：引导式初始化、独立的官方 Codex 登录、诊断、不可变发布目录与 macOS 后台服务命令。

工作台与 CLI 支持**英文、简体中文**，默认跟随系统语言，无法匹配时回退英文。任务内容、用户输入和执行日志保留原文。

PDF / Office / 音视频材料解析、自主派工和离线消息补拉仍不支持。定时提醒与任务可在飞书私聊发送 `/schedule` 管理，也可在本地工作台查看列表。已实现能力与待验收项见[开发路线图](docs/development-plan.md)，当前服务版本从工作台核对。

## 安装与初始化

需要 **Node.js 24.15+**、官方 Codex CLI，以及已启用机器人能力的飞书或 Lark 企业自建应用。使用官方 Codex 认证和服务入口。

npm 发布前，使用 **pnpm 12.15.0** 从源码构建：

```sh
git clone https://github.com/dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
pnpm cli init
```

可恢复的向导会引导完成 Codex 检测、独立登录、项目权限、应用凭据与用户配对。真实模型和收发验证可选，可能使用账号额度。

也可构建本地 CLI 安装包：

```sh
pnpm pack
npm install -g ./namo-0.4.1.tgz
namo init
```

已有配置可通过 `--config` 指定，也支持 `NAMO_CONFIG` 和当前目录已有的 `config.local.json`。配置与数据不会被自动移动或覆盖。

```sh
namo --help
namo ui               # 本地工作台，不启动另一接收端
```

### 语言

在工作台侧栏底部选择 **跟随系统**、**English** 或 **简体中文**。同一浏览器与本机地址会记住选择，重新打开工作台后仍有效。切换时保留当前筛选和未保存的表单输入。

CLI 优先级为 `--lang` → `NAMO_LANG` → 系统语言（`LC_ALL`、`LC_MESSAGES`、`LANG`，最后使用运行时语言）。不支持的系统语言回退英文，`system` 可显式恢复自动选择。

```sh
namo --lang en --help
namo --lang zh-CN init
namo --lang system ui
NAMO_LANG=zh-CN namo ui
```

`--version`、路径和 JSON 输出保持可供程序读取。项目地址放在帮助信息和工作台侧栏中；外部 Agent 输出和历史记录保留原文。

## 聊天命令

常用入口：`/project` 切换项目，`/task` 查看任务，`/cancel` 停止任务，`/new` 开始新上下文，`/profile` 管理本人档案，私聊 `/model` 查看或设置用户默认模型，`/status` 查看服务状态和版本，`/version` 查看 Namo 与 Codex CLI 版本，`/help` 查看命令。

工作台「设置 → Codex CLI 更新」提供版本检查、手动升级、回退和自动升级开关。自动升级默认关闭；开启后由运行中的服务每天检查官方稳定版，忙碌时延后，失败后至少等待一小时再重试。Namo 将完整安装包下载到独立登录目录内的 `namo-cli/`，校验 SHA-256、CLI 版本、app-server 协议、登录、权限配置及模型目录后，空闲时原子切换；不替换全局 CLI，也不改变模型偏好。回退会关闭自动升级。当前支持 macOS/Linux 的 arm64/x64。飞书模型目录每 5 分钟刷新，CLI 切换后会重新获取；更新失败保留原版本。 历史 CLI 包暂不自动清理。


完整用法见[聊天命令](docs/getting-started.md#聊天命令)；文件交付、记忆与审批分别见[文档索引](docs/README.md)。

## 执行边界

- 模板默认只读。通过初始化或工作台，授权具体项目目录、命令联网和本地 Git 提交。
- 服务配置、任务数据和独立 Codex 认证文件始终排除在 Agent 可访问范围之外。不要为解决工具链路径问题而开放整个个人目录。
- Skills 仅开放已启用技能的具体目录及符号链接真实目标，权限为只读；个人 Codex 中停用的技能在 Namo 中仍保持停用。可用 `pnpm run smoke:skills` 验证实际沙箱边界，见[技能访问](docs/architecture.md#模块与约束)。
- 写权限也允许删除文件。取消、超时或重置上下文不会撤销已发生的操作。
- Git push 审批绑定确切任务、用户 / 聊天、项目、预配置远端、分支、HEAD SHA、配置版本和有效期，只允许一次执行尝试。这是**有限保护**，不是完整强制隔离：通用联网 Agent 或其他凭据路径仍可能绕过审批入口。部署没有通用目标实现。
- OpenClaw 导入必须显式选择来源文件、受支持版本和应用；不继承模型认证、网关、插件或任务，也不会自动接管接收端。切换和回退保留为需验证的人工门槛。
- GitHub 等待默认匿名读取公开仓库。通过**连接设置 → GitHub** 选择本机 `gh` 登录，绑定一个配对的本人账号：已准入群聊只读访问仓库，本人私聊可使用账号全部 API 权限，其他私聊不借用凭据。无需逐仓库授权；独立令牌作为高级选项保留。检查等待不会自动执行写操作。见[私有 GitHub 配置](docs/operations.md#github-连接)。
- 平台发送回执表示平台已接收消息，不代表用户已读。发送结果不明时保留记录供核对。
- 主机休眠或断网时无法持续服务；当前没有离线历史消息补拉。
- 禁止提交 `config.local.json`、`data/`、日志、令牌或认证文件。Namo 不会自动接入个人 MCP、插件或第三方模型网关。

CLI 只保留 `init`、`login`、`start`、`service`、`ui`。状态、日志、诊断和 Git 推送审批在工作台中操作；OpenClaw 来源检查在**连接设置 → 运行与维护**，实际导入使用 `namo init --import`。迁移不会自动切换接收端，审批继续绑定预配置目标并要求显式确认。详见 [OpenClaw 迁移](docs/operations.md#openclaw-导入)与 [Git 审批](docs/operations.md#git-推送审批)。

后台服务管理当前支持 macOS；其他平台可前台运行，但尚未完成全部平台验收。当前仅接入 Codex；其他 Agent 仅保留未来插件扩展的可能性，不包含对应 SDK 或探测功能。

## 开发

技术栈为 TypeScript、Node.js 内置 SQLite、飞书官方 Node SDK，以及 stdio Codex app-server。工作台使用 React、Radix Themes 和 Vite，编译资源与字体随 CLI 分发。

```sh
pnpm test
pnpm run smoke:codex          # 协议握手，不进行推理
pnpm run smoke:codex -- --run # 显式真实模型测试
```

完整文档见[文档索引](docs/README.md)，源码构建与验证见[开发指南](docs/architecture.md#开发与验证)，待办见[后续计划](docs/development-plan.md)。

项目地址：[github.com/dofy/namo](https://github.com/dofy/namo)。反馈问题时请提供复现步骤，勿附凭据、私有配置或原始会话数据。

组织配置：在工作台的**连接设置**中配置组织准入、GitHub 登录和本人账号。旧安装保持原范围，直到管理员明确修改。见[组织接入与权限](docs/operations.md#配置与权限)。
