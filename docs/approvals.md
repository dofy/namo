# 受控 Git Push 审批

更新：2026-10-26。对应[主计划](development-plan.md) R3 的首个外部操作。`src/approvals.ts` 已实现独立审批内核；聊天命令、卡片和 CLI 接线由上层完成。首版只处理“把一个已存在、工作区干净的确切 Git commit 非强制推送到一个预配置远端的确切 `refs/heads/*`”。不包含部署、PR 创建、tag、删除分支、force push 或任意 shell 命令。

## 保护范围与诚实边界

这是**有限保护**，不是完整的强制隔离。审批入口本身会严格绑定并重验目标，但当前通用 Codex 运行环境如果拥有联网能力、Git 凭据、HTTP/MCP 或其他发布工具，仍可能绕过这个入口。只有未来把发布凭据和所有可达发布路径隔离到专用执行边界，才能宣称外部操作被强制审批。

因此所有审批预览固定返回 `limitedProtection: true` 及限制说明；UI、飞书回复和验收文档不得省略，也不能把“这个 API 做了审批”描述成“模型已无法绕过”。人工等待的回答不构成审批。上层只能从已验证 owner 命令/卡片回调或本机管理边界构造 `ApprovalActor`，不能从模型文本、引用、附件或 wait reply 推导。

## 记录与状态

审批以 `git-approval:<AP-id>` JSON 记录保存在现有 SQLite `settings` 表，不新增迁移。记录不含凭据、命令输出或 Git 配置值，绑定：

- task ID、owner ID、chat key、项目名、真实项目根目录和任务权限策略指纹；
- 操作类型 `git-push`、预配置 remote 名称及精确 URL/传输类型、目标完整 ref；
- 审批时 HEAD commit、远端 ref 基线、提交标题、配置 revision、创建/过期时间；
- 单次 attempt ID、状态、有限的状态事件和不含原始错误的原因码。

状态为 `pending → approved → executing → succeeded / failed / unknown`。`pending / approved` 可以变成 `rejected` 或 `expired`；执行前任何 owner、chat、task、project、cwd、policy hash、配置 revision、HEAD、remote URL 或远端基线变化都会保存为 `invalidated`。批准只能消费一次，失败或未知都必须新建审批，不能把旧记录改回 approved。

默认有效期 15 分钟，可由策略缩短，不能延长超过 15 分钟。错误 owner / chat、重复批准、批准后拒绝、过期与重复执行均原子拒绝。

## 请求预览与执行前重验

`GitApprovals.request` 只接受管理员传入的 `GitApprovalPolicy.remotes` 中的 remote。它会核对：

1. task cwd 是真实、具体的 Git 顶层目录，不是 `/` 或用户主目录；
2. 工作区（含 untracked 文件，不递归检查子模块）为空，避免把“未提交修改”误说成将被推送；
3. HEAD 是 40/64 位 commit SHA，目标是规范的 `refs/heads/*`；
4. remote 只有一个 push URL，且逐字匹配策略中的 HTTPS、SSH 或本地测试 bare remote；
5. 不存在 Git URL rewrite、自定义 `core.hooksPath` 或实际 `pre-push` hook；依赖 hook/LFS pre-push 的仓库首版拒绝，不能静默跳过其发布步骤；
6. 目标远端 ref 可只读查询，并保存审批时基线；提交标题经控制字符过滤并限制长度。

批准后，`execute` 重做全部检查并比较冻结值；再次读取 HEAD，并在事务内重验最新有效期、配置及批准版本；只有完全一致才以 CAS 把状态改成 `executing`，随后立即使用固定参数执行：

```text
git [安全 -c 配置] push --porcelain --no-verify -- <批准的精确 URL> <批准的 SHA>:<批准的 refs/heads/*>
```

这里没有模型生成的命令、refspec 或参数；不使用 remote 名称执行，从而不继承 remote 的 receive-pack 等行为；没有 force/delete/tag。`execFile` 不经过 shell，Git 可执行文件必须是明确的绝对普通可执行文件。

## URL、hook 与凭据策略

- 拒绝 `ext::`、`file://`、HTTP、带密码/查询/fragment/控制字符或路径穿越的 URL；SSH scp-like 路径使用窄字符集。生产目标只允许策略逐字列出的 HTTPS / SSH，文件路径只允许明确标为 `local-test` 的绝对 bare repository。
- 每次联网/推送都禁用 `protocol.ext`，生产禁用 file protocol；清空代理、extra header、cookie、客户端证书及继承的 `GIT_*` / askpass 环境。HTTPS credential helper 先清空，再只加入策略预先列出的固定 helper 名称；不接受 `!command`、路径或参数。
- SSH 清除 askpass，要求 BatchMode，并覆盖为明确的 ssh 可执行文件及禁用配置文件、转发、local command、ProxyCommand 的固定参数。认证只可能来自该受控 SSH 进程可用的既有 agent/key 环境；模块不读取、输出或保存密钥。
- 仓库自带 `pre-push`、自定义 hooksPath 或 URL rewrite 时直接拒绝。实际 push 同时使用空 hooksPath 与 `--no-verify`，防止检查与执行之间被加入 hook；需要 LFS 或组织 hook 的仓库应另建可审阅的专用发布流程。

所有 Git 调用固定禁用 fsmonitor；工作区检查前按名称审计全部作用域的 `filter.*.clean / smudge / process`，发现可执行过滤器即拒绝，并禁用子模块状态递归。全局 Git LFS 过滤器也会触发拒绝，不会执行仓库或全局配置中的转换程序。服务配置变更后须重新加载策略；旧任务的项目路径和权限指纹也必须仍与当前配置一致。

这些限制可能让部分企业代理、客户端证书、特殊 SSH 配置或自定义 credential helper 无法使用。首版宁可明确拒绝，也不执行仓库提供的程序或扩大凭据面。

## 成功、失败与未知

Git 退出码不单独决定结果。每次尝试后都只读查询同一远端 ref：

- 等于批准 SHA：`succeeded`，远端状态已核对；
- push 非零且远端仍等于审批前基线：`failed`；
- 超时、进程中断、远端不可读，或远端变成既非基线也非批准 SHA：`unknown`。

进程崩溃会留下 `executing`。`recoverInterrupted` 只把它变成 `unknown`；`reconcile` 只读远端，不执行 push。若远端等于批准 SHA则补记成功；仍等于基线则补记失败；其他情况继续未知并要求人工核对。任何情况下都不自动重推。

## 配置、CLI 与飞书控制命令

默认 `gitApprovals.remotes` 为空、`gitBin` 未设置，所有 request 都失败关闭。当前没有 UI 编辑入口，管理员须在本机配置中显式列出目标：

```json
{
  "gitApprovals": {
    "gitBin": "/usr/bin/git",
    "maxTtlMs": 900000,
    "remotes": [
      { "name": "origin", "url": "git@github.com:owner/repo.git", "transport": "ssh" }
    ]
  }
}
```

`credentialHelpers` 只适用于 HTTPS，且只能选固定 allowlist；未配置时不继承任意 helper。`sshCommand` 如配置必须是绝对可执行普通文件。生产不应配置 `local-test`，它只用于隔离 bare repository 验收。

本机入口：`namo ui` → **连接设置 → 运行与维护 → Git 推送审批**。

1. 选择已成功完成的任务、预配置 remote 和目标分支，生成审批预览。
2. 核对项目、任务、提交、目标分支和有效期，明确确认批准或拒绝。
3. 批准后再次确认执行，最多尝试一次推送。结果不明时只核对远端，不能自动重新推送。

预览隐藏 URL 凭据和命令 stderr。批准与执行是独立操作，都有确认对话框；配置或审批版本变化时必须刷新后重审。此入口不放宽现有 Git 权限和单次执行限制。

`ApprovalService` 为飞书控制层提供同步 `handleControl` 和异步 `pump`。Engine 只在入站已持久化且系统身份校验完成后，把以下精确私聊命令交给它；方法先用 SQLite claim + job 记录持久化再返回，不调用模型：

```text
/push-request N-任务编号 remote refs/heads/分支
/push-approve AP-编号 --confirm
/push-reject AP-编号
/push-status AP-编号
```

请求必须引用本人、本聊天中已成功完成的 task。approve 命令在保存批准后执行一次，执行前重新读取 task/HEAD/配置/远端；结果通过原 inbox/outbox 返回。服务重启会把运行中的 push 记为 unknown，后续只允许本机 reconcile，不在飞书端自动重推。群聊、未配对用户、错误语法和外来 task 都在开工前拒绝。

## 验证

`test/approvals.test.ts`、`test/approval-service.test.ts`、`test/management-operations.test.ts` 和 `test/approval-config.test.ts` 使用临时普通仓库和 bare 本地远端，不连接真实服务、不读取凭据：

- 预览与持久绑定、错误 owner/chat、批准/拒绝/过期/重复决定；
- 精确 SHA 到精确分支的一次 push、远端 ref 回读和重复消费拒绝；
- HEAD、配置 revision、hook、URL rewrite 变化导致失效或拒绝；
- 模拟 push 后进程崩溃，通过远端 read 调和成功且绝不重推；
- ext URL、tag ref、任意 credential helper 与非 bare 本地目标失败关闭。
- 默认空配置、CLI 明确确认与 scope JSON、非交互 OpenClaw inspect，以及飞书私聊控制 job 先落库、异步完成、原 inbox 回复且不创建模型 run。

真实 HTTPS/SSH 凭据、真实远端、模型联网绕过与部署均未测试，也不应由本批验收推断为安全或可用。
