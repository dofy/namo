# 安装与第一次使用

Namo 是本地消息桥接器：飞书负责入口，Codex 负责执行，Namo 负责配对、项目路由、会话、队列和运行状态。首版只支持 Codex；探针会区分 Claude Code 本地 CLI 与 OpenClaw Gateway，但尚未实现这两个后端。

当前是**发布前验收版**，尚未发布 npm。包名、许可证和正式发布需要仓库所有者确认，`private: true` 保持启用。

## 安装

先准备 Node.js 24.15+ 和官方 Codex CLI：[官方安装说明](https://learn.chatgpt.com/docs/cli)。Namo 不会静默安装 Agent 或改写个人模型入口。没有 Node 时需要先安装 Node，初始化命令本身无法完成这一步。

拿到本地 tarball 后，在文件所在目录安装：

```sh
npm install -g ./namo-0.1.0.tgz
namo --help
namo init
```

普通用户无需 pnpm、Git、TypeScript 或克隆源码。开发者使用：

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm cli --help
pnpm cli init
```

源码开发时，可将当前检出的 CLI 绑定为本机 `namo` 命令。在仓库根目录执行：

```sh
pnpm run build
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/bin/namo.js" "$HOME/.local/bin/namo"
```

确保 `~/.local/bin` 已在终端的 `PATH` 中。若目标已存在，先检查它指向哪里，不要强制覆盖其他安装。绑定后执行 `namo --help` 验证；修改源码后重新运行 `pnpm run build` 即可使用新代码。

命令绑定不会改变配置查找规则：在本仓库运行会沿用 `config.local.json`；在其他目录操作这份配置时显式使用 `namo ui --config /absolute/path/to/namo/config.local.json`。这只绑定 CLI，不会切换或重启现有接收服务。

后台服务不能绑定到 `npx` / `pnpm dlx` 临时缓存中；需要先持久安装。当前后台服务管理经过设计支持 macOS；其他系统可以前台启动，但尚未经完整平台验收。

## 前端开发

本地工作台使用 React + TypeScript + Radix Themes，源码位于 `ui/`，浏览器 API 类型位于 `src/ui-contract.ts`。Vite 将资源构建到 `dist/ui/`，由现有回环 HTTP 服务提供页面和 API。安装包内已包含产物，使用者无需安装 Vite、React 开发依赖或额外启动前端服务。

```sh
pnpm run build         # 构建 CLI / 服务端及前端，并检查两侧类型
pnpm cli ui            # 打开带本机授权的工作台
```

修改前端时，在另一个终端运行 `pnpm run ui:watch`；构建完成后刷新工作台。这里使用文件监听构建，不另开 Vite 开发服务器，也不将管理 API 暴露给跨域代理。单独检查前端类型使用 `pnpm run typecheck:ui`；完整验证使用 `pnpm test`。修改服务端代码后，重新构建并重开 UI 进程即可，不需要重启飞书 Bot。

页面按任务、项目权限、连接诊断拆分，公用控件使用 Radix Themes。组件升级后应验收 Select / Dialog 的键盘操作与 CSP：动态样式使用响应 nonce，两个固定 viewport 样式由服务端精确哈希放行，不允许改成任意内联脚本或样式。

## 初始化向导

`namo init` 必须在本机交互终端运行，不能通过管道提交凭据。Secret 输入不回显。Ctrl+C 后可再次运行；已保存步骤仍在。

1. 检测 Codex，确认实际可执行路径。现有配置可以直接沿用。
2. 选择具体项目目录，选择只读或项目开发模式，以及是否允许命令联网。
3. 创建自己的飞书企业自建应用，开启机器人能力，输入 App ID 和 App Secret。
4. 检查 Namo 独立的 Codex 认证和权限协议。若未登录，可启动官方浏览器登录流程。不会复制个人 Codex 认证、MCP、插件或网关配置。
5. 验证飞书凭据，并启动仅用于引导和配对的长连接。**保持此窗口在线**，再去飞书后台保存长连接接收方式。
6. 订阅消息事件、申请权限、设置应用可用范围并发布。需要管理员审批时，等待审批完成再继续。
7. 在机器人私聊中发送本地显示的一次性代码，随后回到本机终端确认该用户身份。无需手工查询或复制 open_id。
8. 可明确同意进行真实模型收发测试：再次从已授权私聊发送测试码，Namo 调用 Codex，并等待飞书发送回执。此步骤可能使用账号额度。
9. macOS 用户可选择安装后台服务，向导会等待连接就绪。登记成功但尚未 ready 会明确报告，不宣称已在线。

配对代码只允许真人私聊、完全匹配、10 分钟有效且单次使用；本机确认前不授权、不执行任何用户任务。不会自动把第一个发消息的人设为主人。已有用户保留，向导新增用户不会清空旧白名单。

## 飞书后台配置

入口：[飞书开放平台](https://open.feishu.cn/app)，国际版选择 [Lark](https://open.larksuite.com/app)。需要的是企业自建应用中的**应用机器人**，不是群自定义 webhook 机器人。

- 启用机器人能力。
- 事件接收方式：使用长连接接收事件。
- 接收消息事件：`im.message.receive_v1`。
- 单聊接收：`im:message.p2p_msg:readonly`。
- 群 @ 接收：`im:message.group_at_msg:readonly`。
- 机器人发送：`im:message:send_as_bot`。
- 设置应用可用范围，创建版本并发布，按租户规则完成审批。

长连接不需要公网回调地址或内网穿透。本地客户端在线后才能在平台保存对应订阅方式；详见[飞书官方长连接说明](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)。

如果凭据有效却收不到配对消息，依次检查：应用是否已发布、是否订阅正确事件、消息权限是否生效、用户是否在可用范围，以及是否有旧服务使用同一应用接收事件。Namo 不会为了测试擅自停用 OpenClaw 或其他接收端。

## 配置与恢复

```sh
namo config path
namo init --config /absolute/path/to/config.local.json
```

配置查找优先级：显式 `--config` → `NAMO_CONFIG` → 当前目录已有 `config.local.json` → 系统用户目录中的 `config.json`。

默认用户目录：macOS `~/Library/Application Support/Namo`，Linux `$XDG_CONFIG_HOME/namo`（默认 `~/.config/namo`），Windows `%APPDATA%/Namo`。可通过 `NAMO_HOME` 显式选择隔离实例目录。初始化数据、检查点、日志和独立 Agent 登录放在配置的 `dataDir` 中。

旧配置和 `data/` 不会自动移动。已有配置修改前会在原 `dataDir/config-backups/` 保存私有备份；未知配置字段、既有用户、会话与消息记录保留。检测到配置被其他程序修改时拒绝覆盖。运行中的配置会阻止 init 启动第二个接收端；先停止原实例再初始化。

收到测试回执的配置再次初始化时，不会重复调用模型或发送测试消息。上次模型执行或发送结果未确认时，必须先核实，再显式同意重新测试，不会自动重跑。

## 日常操作

```sh
namo agent list
namo doctor
namo doctor --json
namo doctor --live  # 明确调用模型，可能使用账号额度
namo agent test --live
namo login
namo start         # 前台，Ctrl+C 停止
namo status
namo logs
namo ui            # 打开本机工作台，不启动飞书接收端
namo issues        # 列出待核对异常
namo service install
namo service status
namo service stop
namo service start
namo service restart
namo service uninstall
```

需要指定现有配置时，把 `--config /absolute/path/config.json` 加到对应命令。诊断默认不调用模型，也不会启动另一个飞书接收端。它区分命令发现、协议/权限配置、独立账号认证、项目目录、飞书凭据与用户配对。`doctor --live` 只验证 Agent 推理；完整飞书收发通过 init 验证。

诊断的退出码：存在失败项为 1，仅警告为 0。`--json` 可用于脚本。取消初始化返回 130。

当前后台状态通过运行进程和本次实例的健康记录一起判断。旧版服务没有健康记录时，显示连接未知，而不是根据 PID 推断在线；更新后重启即可开始生成健康记录。`uninstall` 仅卸载服务，保留配置、数据和登录；重新安装会使用当前稳定的 Node 和 CLI 路径。

## 本地工作台与任务卡片

`namo ui` 自动打开只在本机可访问的工作台。保持终端进程运行，Ctrl+C 关闭并撤销本次页面授权；页面会话有效期为 2 小时，失效后重新运行命令。当前自动打开支持 macOS / Linux，Windows 继续使用 CLI，尚未完整验收。

- **任务与工作线**：查看任务结果、运行与投递状态，停止尚未结束的任务，核对中断或发送结果不明。核对后只记账或重发已保存的指定结果，不重新调用模型。
- **项目与权限**：添加 / 修改项目、默认项目、读写和联网权限、模型、并发与时限。先保存并备份，再确认应用；在途任务存在时不会重启。原 Secret 不显示，输入新 Secret 才替换。
- **Agent 与飞书**：运行与 CLI 相同的连接诊断，查看官方登录命令和飞书设置 / 配对步骤。登录与新增用户仍在本机终端完成；配对前要停止当前接收端，避免重复连接。
- **用户档案**：选择已配对用户，编辑称呼、语言和时区，查看保存版本与修改来源。草稿跨页面保留；冲突不会覆盖新内容。清空资料需确认，不移除用户配对。

旧数据库只供查看；工作台不会替你迁移在线库。首次升级到本版需按[运维说明](operations.md)安排维护窗口。

基础卡片默认关闭。启用前，在应用后台的回调配置中选择长连接并添加 `card.action.trigger`，按后台要求发布 / 生效；然后在工作台勾选“使用任务卡片与操作按钮”并应用配置。按钮约 15 分钟有效，过期后使用 `/task`、`/cancel`。卡片为接收和结果两类独立消息，尚非流式刷新；缺少回调时文字命令仍可用。本版真实卡片收发与按钮还需上线验收，不以隔离测试替代。

卡片格式被明确拒绝时改发文字；网络超时或回执不明时保留异常，先核对飞书再决定重发，避免重复消息。

### 查看执行证据

升级到 schema 4 接收服务后，新任务详情会显示文件变更、命令退出码、产物与提交线索。飞书答复附带简要执行记录，完整的已保存记录可从工作台任务详情查看。历史任务不补造记录；取消或中断可能只留下部分证据。退出码和文件存在性不能替代内容验收，详见[范围与限制](result-evidence.md)。

## 本人档案

升级到含档案功能的接收服务后，在机器人私聊中单独发送 `/profile`。回复包含当前版本和可复制的修改命令，例如首次设置：

```text
/profile set 0 name 小七
```

每次修改后使用回复中的新版本继续设置：`/profile set 1 language zh-CN`、`/profile set 2 timezone Asia/Shanghai`。称呼最多 80 字；语言使用 `zh-CN` / `en-US` 等语言标签，时区可用 `Asia/Shanghai` / `UTC`。值为 `-` 时清空单个字段，`/profile clear 当前版本` 清空三个字段。

群聊只提示转到私聊，不回传档案。引用、富文本、合并转发和材料不作为档案更新来源；只能修改事件中实际发送者自己的档案。平台展示名称暂未同步，称呼是用户自设字段。同名用户及不同应用的 open_id 不会合并。

保存立即可被档案查询读取，无需重启；它不会修改白名单、项目权限或既有任务。当前仅提供档案管理，语言和时区尚未改变 Agent 回复、页面显示时区或调度行为；上下文注入与长期偏好属于 M4。清空后保留递增版本和修改元数据，历史聊天、消息与备份不会一并删除。

## 发布边界

包只包含 CLI、编译产物、示例配置、文档和品牌资源，不包含本地配置、data、测试、临时文件或登录信息。`pnpm pack --out work/namo-0.1.0.tgz` 构建验收包，不会发布。

当前推送和部署确认由每轮注入的对话规则约束，尚未提供命令级强制审批拦截。不要将其宣传为已经实现强制安全审批。
