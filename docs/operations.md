# Namo 运维与配置指南

首次安装请优先使用 `namo init`，见[安装与第一次使用](getting-started.md)。本页保留源码开发、旧配置兼容和高级手工配置说明。

本地飞书机器人：TypeScript + Node.js 内置 SQLite + 官方 Codex app-server。面向个人或少量可信用户，先把消息接收、会话、执行、回复、失败恢复做完整。

## 已实现

- 飞书长连接；私聊与群 @；用户 open_id 白名单、可选群白名单；只接收真人消息。
- 文字与基本富文本输入。独立附件 / 合并转发先保存材料描述、等待要求；未下载解析实际内容。
- 持久入站，重复 message_id 不重复执行；同群串行、不同群最多两个执行任务。
- 按话题、用户和工作线续接 Codex thread；最终答复由服务发送，思考和工具输出不进入飞书。
- 入站收到提示、最终回复、长回复分段；每段有持久 UUID 和飞书消息回执。
- `/status`、`/whoami`、`/cancel`、`/reset`、`/help`、`/project`。群里使用这些命令也需要 @ bot。
- 排队请求重启后继续；执行中断明确告知，不盲目重跑；发送结果未知单独记账，不盲目重发。
- 单实例锁、配置检查、协议 smoke、macOS launchd 安装脚本。
- 本地工作台、配置保存 / 应用、任务与运行详情、异常核对和可选固定任务卡片（M2 第一批源码；在线验收状态见 [记录](m2-verification.md)）。

当前不包含：文件解析、流式卡片、定时提醒、后台派工、跨群共享记忆、自动合并发布。Codex 调用结束后其执行器进程会退出，不能依赖它继续后台任务。

## 启动

需要 Node.js 24.15+、pnpm 12.15.0、已安装的官方 `codex` CLI。本项目已在 codex-cli 0.154.0 上验证协议握手。CLI 升级后先运行 smoke 和测试。

```sh
cd /absolute/path/to/namo
pnpm install --frozen-lockfile
pnpm run build
cp config.example.json config.local.json
chmod 600 config.local.json
```

如果 `config.local.json` 已经存在，不要用复制命令覆盖它。本地配置不会随仓库分发。

编辑 `config.local.json`：

- `feishu.appId`：原 bot 应用的 App ID。
- `feishu.appSecret`：可直接填入本地被 Git 忽略的配置；也可以留空，通过 `appSecretEnv` 指定的环境变量提供。不要提交配置或把 Secret 发到聊天里。
- `feishu.allowedUserIds`：允许操作 bot 的用户 **open_id**，例如 `["ou_..."]`。空数组拒绝所有人。可从飞书 API 调试台或现有 OpenClaw 的配对/身份记录取得；不是手机号、姓名或 user_id。
- `allowedChatIds`：空数组表示所有会话都允许这些白名单用户使用；填写后仅指定会话允许。
- `requireMention`：默认群聊必须 @ 当前 bot；私聊不需要。
- `feishu.cards`：默认 false，保持原有文字发送。设为 true 后发送固定任务卡片；按钮需在飞书回调配置订阅 `card.action.trigger`，并按后台要求发布 / 生效。
- `codex.model`：空值采用这个独立 Codex 环境的默认模型，可改为当前账号有权使用的模型。

本项目使用独立的 `data/codex-home`。通过官方流程登录：

```sh
pnpm run login
pnpm run check
pnpm run smoke:codex
# 登录后验证一次真实模型调用（会占用账号额度）
pnpm run smoke:codex -- --run
```

独立登录避免加载你日常 Codex 的 MCP、插件和私人项目配置。不会复制 OpenClaw 凭据、修改已有 Codex 配置或设置第三方模型入口。不要把 `codex.home` 指向日常 Codex 目录来省略登录。

配置模板默认 `read-only`：可以读取当前工作区及运行时路径、执行不产生写入的命令；不能修改代码或生成构建文件，命令联网默认关闭。未配置项目时使用 `data/workspaces/<会话哈希>`。

以下是项目开发模式的配置示例：默认项目 `bot` 指向你的仓库绝对路径，启用 `workspace-write` 和命令联网，全局并发设为 1，避免聊天之间同时修改项目。

```json
{
  "codex": {
    "sandbox": "workspace-write",
    "projects": { "bot": "/absolute/path/to/namo" },
    "defaultProject": "bot",
    "networkAccess": true,
    "allowLocalCommits": true,
    "readPaths": ["/opt/homebrew"],
    "denyPaths": ["~/.ssh", "~/.aws", "~/.openclaw"]
  },
  "concurrency": 1
}
```

将这些字段合并到现有本地配置，保留飞书凭据和其他 Codex 配置。项目目录必须已存在，不接受主目录或 `/`。工具仅读写当前项目及系统临时目录，Homebrew 仅可读以运行工具及动态库；`config.local.json`、服务 `data/` 与 Codex 登录目录会自动禁止工具读取和写入。`allowLocalCommits: true` 仅覆盖当前工作区 `.git` 的只读规则，支持暂存和本地提交；`.agents`、`.codex` 等其他保护和明确排除的凭据路径继续生效。只读模式不能启用该选项。外部 Git worktree 元数据目录不会自动获得写权限。不能把这项配置理解为整台电脑的管理员权限。

飞书发送 `/project` 查看当前目录和项目列表，`/project bot` 切换。仅能选择本地配置中的项目；切换会清理上下文，正在执行或排队时拒绝切换。第一次从原隔离工作区进入项目也会开始新上下文。新增项目需在本地 `codex.projects` 中添加名称和绝对路径，然后重启服务；不会根据模型输出自动扩大目录权限。普通代码文件可修改或删除，因此执行破坏性操作前仍需用户明确指示。

命令可以运行测试、构建和访问网络。pnpm 与兼容的 npm 命令使用 `/bin/sh` 执行脚本，并使用独立临时缓存与空用户认证配置；pnpm 配置目录也与个人环境隔离，不继承个人包仓库登录凭据；私有包、SSH、推送和部署可能需要另外配置，不会自动接入你的账号。本地修改、测试和提交可作为开发流程直接完成，只提交本次任务相关文件。Git 命令不加载个人全局/系统配置及认证助手；每个项目需有自己的仓库局部作者姓名和邮箱；不会自动导入个人 Git 认证凭据。

推送和部署前必须先列明仓库、分支、提交或部署环境，在对话中等待用户后续确认；一般开发请求不算确认，目标或内容变化需要重新确认。脚本和 hooks 内的推送、部署也适用。当前确认由每轮注入的 bot 指令约束，没有实现命令级强制拦截或通用发布审批引擎。未经明确要求不会安装依赖。

修改配置或代码后：

```sh
pnpm run build
pnpm run service:uninstall
pnpm run service:install
```

当前 Codex 0.154.0 使用命名权限配置 `feishu-bot`，并允许读取 Codex 自身安装目录以启动辅助进程；不自动扫描主机和祖先目录的 AGENTS.md；服务显式加载当前项目根目录的普通 AGENTS.md 文件，拒绝符号链接，子目录约定需要执行器按任务读取。权限接口需启用 app-server 的 experimentalApi。已实测原只读边界，并在项目开发模式下验证代码修改、命令、构建及联网；项目外测试文件和 bot 配置仍被拒绝。升级 CLI 后应重新验证这些边界。

## 切换原 bot

1. 保持应用的机器人能力和可用范围；事件订阅使用**长连接**，订阅 `im.message.receive_v1`，具备接收相关私聊/群 @ 及机器人发送消息的权限（常用 `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`）。开启所需权限后按飞书平台要求发布应用。
2. 停用 **OpenClaw 的这个飞书应用接收端**。同一应用的两个长连接会随机分走事件，不能同时运行旧新服务来验证。
3. 前台运行：

```sh
pnpm start
```

看到日志 `ready` 才代表长连接已就绪。私聊 bot：`你好，只回复连接成功`；随后问一个承接上文的问题验证会话续接。群里 @ bot 发送同样的消息。

4. 验证 `/status`、`/whoami`、`/cancel`、`/reset`。用 Ctrl+C 停止后重新启动，排队消息应继续处理；中断中的任务应收到明确说明。
5. 确认前台运行正常后，可安装自动启动：

```sh
pnpm run service:install
# 卸载服务，保留配置和数据
pnpm run service:uninstall
```

launchd 不继承终端临时导出的 Secret。使用自动启动时，推荐把 Secret 放在权限 600 的本地配置；脚本不会把凭据写进 plist。

回滚时先停止/卸载本服务，再恢复 OpenClaw 的对应飞书接收端。不要删除 `data/` 来回滚。

## 状态与恢复语义

```sh
pnpm run status
tail -f data/service.log
```

数据库 `data/bot.sqlite` 保存消息正文和回复，因此应视为私有数据。目录默认 700、文件默认 600；本地状态命令只打印消息 ID、状态、错误类别和平台回执，不打印正文。需备份时应停止服务后备份整个 data 目录，不要在运行中只复制 sqlite 主文件忽略 WAL。

| 状态 | 含义与处理 |
|---|---|
| queued | 已入库，尚未启动；重启后可继续 |
| running | 模型正在执行 |
| awaiting_reply | 结果已落库，等待发送；不会重新调用模型 |
| replied | 结果分段已由平台接受或人工确认收到；具体依据查 outbox，不代表平台已读 |
| failed | 执行失败/取消/中断，说明消息已发送 |
| delivery_unknown | 发送中断或回执不明，可能已发送；先在飞书核查，不自动重发 |
| delivery_failed | 平台明确拒绝；修复权限/配置后决定如何处理 |
| delivery_closed | 人工放弃某个结果分段，或旧消息执行结论无法还原；核对历史保留 |

`deliveryIssues` 会列出异常出站记录。发送结果不明不会自动重发；先在飞书核实再选择受控处理，不能在平台去重时效外承诺 exactly-once。涉及写操作先核对实际效果，不要只因没看到回复重新发起同一任务。

### 人工核对与受控处理

本机可用 `namo ui`，或执行：

```sh
namo issues
namo issue D-42
# 从 issue 输出复制当前 stamp，填写真实核对依据
namo resolve D-42 <stamp> received "已在飞书看到这一段" --confirm
namo resolve D-42 <stamp> retry "已核对，仍决定重发" --confirm
namo resolve D-42 <stamp> dismiss "不再发送这一段" --confirm
namo resolve N-AAAAAAAAAAAA <stamp> reviewed "已检查代码与外部效果" --confirm
```

以上是互斥处理示例，不要逐条执行。`D-编号` 对应一个出站分段；`retry` 只允许结果分段，明确接受可能重复发送的风险，绝不重跑模型。`received` 记为人工 `confirmed`，不会伪造平台 message_id；`dismiss` 保留原记录并允许后续分段继续。执行 `reviewed` 不改原任务终态、不重发未确认修订；继续工作需明确发起后续要求。核对写入审计事务，记录变化后必须重新查看当前 stamp。

飞书使用 `/issues`、`/issue 编号`，再按机器人返回的 `/resolve` 命令填写依据；仅处理本人、本聊天的记录。本机工作台作为本机所有者可核对本实例全部任务。核对依据不要写入凭据，界面和 CLI 会对已知 Secret 及常见凭据格式脱敏。

### 本地工作台与配置应用

```sh
namo ui --config /absolute/path/config.local.json
```

只绑定随机端口的 `127.0.0.1`；启动授权在 5 分钟内单次兑换，页面会话 2 小时有效。自动打开后 URL 不保留授权片段，终端不打印授权值。Ctrl+C 关闭后会话失效。不要代理到公网或共享浏览器会话；这里没有远程多用户管理功能。

项目 / 权限、模型 / 并发 / 时限、群 @ 与卡片选项可直接编辑；原凭据不回传，Secret 替换只写入本地。配置保存复用初始化的校验、私有备份及并发冲突检测，保存本身不会重启。数据目录、应用身份、登录目录和白名单不在此编辑；新增用户按页面提示在维护窗口走 `namo init`。

“应用已保存配置”须单独确认，只对兼容的后台服务执行，并拒绝在途任务 / 待发送消息；暂停领取后沿用服务管理入口重启。旧进程、前台进程及旧 schema 不自动接管。失败会撤销调度暂停并提示核对服务，不能据“已尝试启动”认定已经连接。配置有效性错误可以修正；JSON 语法损坏等无法读取的配置仍需在终端修复。

卡片仅冻结接收与结果消息，按钮 15 分钟有效，支持状态查询和停止。停止检查任务当前输入版本；已结束或已修改任务的旧按钮不会执行取消。重复回调不会重复处理。卡片被明确判定为格式错误才使用文字兜底；超时 / 回执未知保留异常。正文按纯文本渲染，无流式更新或自动结构化证据提取。

单次模型调用默认 10 分钟；超时停止本次执行器的独立进程组。普通同聊天新任务在前一条回复收口后执行；用 `/amend N-编号 补充` 或引用本人任务消息追加要求，运行中通过 Codex `turn/steer` 提交。接受回执不代表要求已完成，更不代表此前操作撤销。未接受或结果不明会记录为待核对，不自动重送；需要停止用 `/cancel N-编号`。

## M1 消息、工作线与任务

`/tasks` 列出本人、本聊天最近 10 项任务；`/task N-编号` 分别查看执行状态和投递状态，并显示输入版本与修订提交状态。`needs_attention` 表示存在尚未确认送入执行器的修订；`interrupted` 不会自动重跑。`task_runs` 记录执行尝试，出站账仍是发送事实来源。

独立合并转发、附件及 `/material 内容` 先成为待处理材料，不调用模型。后续普通要求或 `/run 要求` 只关联同用户、话题、项目 / 权限版本内的材料。10 分钟未收到要求只提示，历史保留；同话题最多暂存 30 条，组合输入上限 80000 字符，超限不创建部分任务。平台表现为普通文字的逐条转发无法可靠识别，使用 `/material` 显式提交。

M1 只保存附件、合并转发的资源描述，未下载或解析其实际内容。引用只支持本机已知的本人任务或同话题待处理材料；未知引用会要求粘贴内容，不猜测原文。群旁听、历史补拉、外部引用抓取和跨聊天 session 共享尚未实现。

`/new` 或 `/reset` 为当前用户、话题开始新工作线，`/session` 查询，`/session W-编号` 显式续接本人在本聊天的工作线；忙时拒绝切换。项目改变新开工作线，既有任务固定项目目录和权限指纹。全局并发仍有效，但同真实目录及父子目录全部任务串行。取消只影响本人任务，不取消群内其他人的工作。

### 升级和回退

2026-10-26 已在明确授权的维护窗口将原服务切换到 M1；沿用原配置和登录，在线数据库迁移至 schema 1。核心私聊链路、工作线续接和空闲重启已实测，具体范围见 [M1 验收](m1-verification.md)。

其他既有安装升级时先核对在途任务，停止并确认旧进程退出，再备份配置和完整数据目录，并生成 SQLite 一致性快照（不能只复制正在写入的主文件而遗漏 WAL）。M1 首次以读写模式打开库增加消息 envelope 和任务相关表，设 `user_version=1`；M2 第一批增加 `reconciliations / card_actions` 与 `outbox.payload`（schema 2），基础档案进一步增加 `user_profiles / profile_changes`，当前源码事务化升至 schema 3。保留旧表和历史字段；旧排队消息会关联任务，旧进行中消息只保留中断说明，不重跑。

真实库的私有副本已完成 schema 2 及 schema 3 迁移验证，在线服务仍为 schema 1。`namo ui` 读取旧库不会迁移，旧库异常处理、档案编辑与配置应用被禁用。首次上线必须在明确授权的维护窗口手动完成，不能靠点击 UI 应用跳过版本检查。

切换后核对连接、队列、任务和消息回执。旧二进制不理解新任务与修订，不能直接用它消费新版库；回退需要停止新版、核对外部效果及新增消息，再选择已备份数据库和对应版本，不能静默覆盖或丢弃切换后的数据。没有自动降级或结果未知任务重放。

Mac 休眠/断网期间不提供在线服务。此版依赖飞书重投和 SDK 重连，没有实现历史消息补拉，不能承诺长时间离线期间全部消息不丢。启动允许最多 60 秒等待连接（单次握手 15 秒）；失败时先关闭执行器、数据库和锁，再退出，让 launchd 重启，避免 SDK 定时器把失败进程留在线上。运行期由 SDK 重连，持续失败仍应人工处理，不能仅凭进程还活着判断 bot 在线。

## 开发与验证

```sh
pnpm test
pnpm run smoke:codex
```

测试使用真实 SQLite 文件与实际子进程 JSON-RPC 模拟器，覆盖：持久去重、同群顺序、全局并发、重启恢复、取消、消息分段、发送不确定性、模型断流/失败/超时，以及身份与凭据边界。不会连接飞书或发送消息。

参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[飞书官方 Node SDK](https://github.com/larksuite/node-sdk)。

## pnpm 依赖管理

使用 `packageManager` 固定的 pnpm 12.15.0 和 `pnpm-lock.yaml`；安装依赖运行 `pnpm install --frozen-lockfile`，新增依赖使用 `pnpm add`，不要生成 npm 或 Yarn 锁文件。

`pnpm-workspace.yaml` 保存单包项目的 pnpm 设置，并不引入额外子项目。`saveExact` 保持直接依赖精确版本；protobufjs 的 postinstall 仅检查依赖版本格式，已显式禁止，实际 SDK 导入和测试已验证。

迁移保留原 npm 锁文件中的全部 73 个依赖版本。pnpm 的默认发布时间策略会回退发布未满 24 小时的版本，因此仅为迁移前已经锁定的 `follow-redirects@1.16.2` 保留精确版本例外；没有全局关闭发布时间保护。
