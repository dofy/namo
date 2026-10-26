<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — 一只蜷着尾巴的橙色狐狸" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>住在本地，帮你把事情做完的小狐狸。</strong><br />
连接飞书、Lark 与 Codex 的本地 AI 工作伙伴。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">问题反馈</a> · <a href="docs/development-plan.md">开发计划</a></p>

Namo 将聊天应用连接到本地开发环境。从私聊或群 @ 发起任务，在指定项目中修改文件、运行命令和测试，再将结果回复到原会话。

Namo 管理消息、队列、项目、会话和执行边界；任务理解与工具执行交给官方 **Codex app-server**。代码、任务状态和执行环境位于本机，模型推理使用 Codex 账号对应的服务。

**状态：早期可用版本。** 面向个人或少量可信用户，已验证真实飞书收发，运行主机仍需自行维护。尚未发布 npm 包。

## 已有能力

- **飞书 / Lark 入口**：长连接、私聊、群 @、文字与基本富文本；通过一次性本地配对和用户白名单限制访问。
- **项目与会话**：在指定目录工作，保留会话上下文，切换项目并显式续接历史会话。
- **持久化任务**：SQLite 入站与出站、消息去重、输入修订、同聊天及同项目串行，以及全局并发限制。
- **提问与回答**：Agent 可暂停等待补充；引用问题回复，或点击与问题对应的选项按钮后继续。
- **独立运行进程**：任务与接收服务分别运行；中断或结果不明时保留记录供核对，不盲目重跑。
- **执行证据**：文件补丁、命令退出码、产物检查和 Git HEAD 快照，并明确采集范围与限制。
- **本地工作台**：Dashboard、任务和会话搜索、用户 / 项目 / 状态 / 日期筛选、分页、详情、用户档案、配置与连接诊断。
- **简洁聊天回复**：普通回答直接发文字；可选任务卡片提供详情与停止操作。按钮需配置飞书回调。
- **本地服务管理**：引导式初始化、独立的官方 Codex 登录、诊断、不可变发布目录与 macOS 后台服务命令。

工作台与 CLI 支持**英文、简体中文**，默认跟随系统语言，无法匹配时回退英文。任务内容、用户输入和执行日志保留原文。

当前不包含图片 / 文件 / 语音解析、流式卡片、定时提醒、后台派工、长期记忆或离线消息补拉。里程碑和未完成的真实场景验收见[开发计划](docs/development-plan.md)。

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

可恢复的向导会引导完成 Agent 探测、独立登录、项目权限、应用凭据与用户配对。真实模型和收发验证可选，可能使用账号额度。

也可构建本地 CLI 安装包：

```sh
pnpm pack
npm install -g ./namo-0.1.0.tgz
namo init
```

已有配置可通过 `--config` 指定，也支持 `NAMO_CONFIG` 和当前目录已有的 `config.local.json`。配置与数据不会被自动移动或覆盖。

```sh
namo --help
namo agent list
namo doctor           # 检查环境与连接，不进行模型推理
namo doctor --live    # 显式真实模型测试，可能使用账号额度
namo status
namo logs
namo ui               # 本地工作台，不启动另一接收端
```

### 语言

在工作台侧栏底部选择 **跟随系统**、**English** 或 **简体中文**。同一浏览器与本机地址会记住选择，重新打开工作台后仍有效。切换时保留当前筛选和未保存的表单输入。

CLI 优先级为 `--lang` → `NAMO_LANG` → 系统语言（`LC_ALL`、`LC_MESSAGES`、`LANG`，最后使用运行时语言）。不支持的系统语言回退英文，`system` 可显式恢复自动选择。

```sh
namo --lang en --help
namo --lang zh-CN init
namo --lang system doctor
NAMO_LANG=zh-CN namo doctor
```

`--version`、路径和 JSON 输出保持可供程序读取。项目地址放在帮助信息和工作台侧栏中；外部 Agent 输出和历史记录保留原文。

## 聊天命令

| 命令 | 作用 |
| --- | --- |
| `/project [项目名]` | 列出项目，或切换项目并开始新上下文 |
| `/status` | 查看队列、目录和权限状态 |
| `/tasks`、`/task N-编号` | 查看本人在本聊天中的任务 |
| `/material 内容` | 暂存材料，等待处理说明，最长十分钟，不自动执行 |
| `/run 要求` | 开工并关联待处理材料；普通文字也可直接开工 |
| `/amend N-编号 补充` | 追加任务输入；引用本人任务消息也可追加 |
| `/cancel [N-编号]` | 停止本人任务；无编号时作用于当前话题 |
| `/session [W-编号]` | 查看或选择工作线，续接 Agent 上下文 |
| `/new`、`/reset` | 开始新上下文，保留文件和任务历史 |
| `/resume WAIT-编号 回答` | 回答等待中的问题；也可引用回复或点击选项 |
| `/profile` | 在私聊中查看和管理基础档案 |
| `/issues`、`/issue 编号` | 查看执行或投递异常，按返回的指引核对 |
| `/whoami`、`/help` | 查看聊天身份或可用命令 |

## 执行边界

- 模板默认只读。通过初始化或工作台，授权具体项目目录、命令联网和本地 Git 提交。
- 服务配置、运行数据和独立 Codex 登录目录始终排除在 Agent 可访问范围之外。不要为解决工具链路径问题而开放整个个人目录。
- 写权限也允许删除文件。取消、超时或重置上下文不会撤销已发生的操作。
- 推送和部署需要 Agent 先请求明确确认；目前尚未实现命令级强制审批拦截。
- 平台发送回执表示平台已接收消息，不代表用户已读。发送结果不明时保留记录供核对。
- 主机休眠或断网时无法持续服务；当前没有离线历史消息补拉。
- 禁止提交 `config.local.json`、`data/`、日志、令牌或认证文件。Namo 不会自动接入个人 MCP、插件或第三方模型网关。

后台服务管理当前支持 macOS；其他平台可前台运行，但尚未完成全部平台验收。Claude Code 与 OpenClaw 只提供发现状态，尚未支持作为执行后端。

## 开发

技术栈为 TypeScript、Node.js 内置 SQLite、飞书官方 Node SDK，以及 stdio Codex app-server。工作台使用 React、Radix Themes 和 Vite，编译资源与字体随 CLI 分发。

```sh
pnpm test
pnpm run smoke:codex          # 协议握手，不进行推理
pnpm run smoke:codex -- --run # 显式真实模型测试
```

更多说明：

- [首次使用与前端开发](docs/getting-started.md)
- [配置与运维](docs/operations.md)
- [架构说明](docs/architecture.md)与[开发计划](docs/development-plan.md)
- [执行证据](docs/result-evidence.md)、[独立运行](docs/runner.md)、[等待与恢复](docs/waits.md)
- [发布隔离](docs/release-isolation.md)与[品牌资源](docs/brand.md)

项目地址：[github.com/dofy/namo](https://github.com/dofy/namo)。反馈问题时请提供复现步骤，勿附凭据、私有配置或原始会话数据。
