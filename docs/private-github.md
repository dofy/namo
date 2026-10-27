# Private GitHub checks / 私有 GitHub 检查

Namo can wait for checks on a private pull request at one fixed HEAD. This is read-only access for the external-wait feature; it does not clone repositories, grant the model GitHub credentials, or authorize a push, merge or deployment.

Namo 可以等待私有 PR 固定 HEAD 的检查结果。本功能只读，不代表支持私有仓库克隆，也不会把凭据交给模型或授予推送、合并、部署权限。

## Local GitHub login (recommended) / 本机 GitHub 登录（推荐）

In **Connections → GitHub**, choose **Local GitHub login**, select your paired Feishu user and save. The CLI offers the same choice in `namo github configure`. Namo connects the active `github.com` account from the local `gh` installation. If needed, run `gh auth login` first. No separate token or repository allowlist is required; the selected user can read checks in repositories that account can access, in direct messages only.

在**连接设置 → GitHub**选择**本机 GitHub 登录**，选择自己的飞书配对用户后保存；`namo github configure` 提供相同选项。保存时连接本机 `gh` 的当前 GitHub 账号。未登录时先运行 `gh auth login`。无需另建令牌或重复填写仓库白名单；仅所选用户的本人私聊可查询该账号有权访问的仓库。

The executable, gh configuration directory and account identity are saved. Credentials are retrieved for that specific account only into service memory and used with fixed read-only GitHub REST endpoints; they are never copied into Namo configuration or model input. Ambient `GH_TOKEN`, `GITHUB_TOKEN`, debugging and proxy variables are not inherited. Switching gh's active account does not silently switch Namo's selected account; save again to reconnect. Background services must run as the same local user with access to that account's credential store.

保存的信息是 `gh` 路径、配置目录与账号身份。服务仅在内存中取得该账号的凭据，用于固定 GitHub REST 只读接口，不写入 Namo 配置、不交给模型，也不继承环境中的令牌、调试和代理变量。切换 `gh` 当前账号不会静默切换 Namo 已选账号；重新保存可重新连接。后台服务必须以能访问该账号凭据存储的本机用户运行。

Logout, loss of repository access or an account mismatch blocks private reads. Before consuming a saved ready result, Namo reads the fixed HEAD/checks again with current access. Changed or unavailable evidence remains waiting until it can be verified, cancelled or timed out. Choose **Public repositories only** to disable private access. The configured badge records selection, not a guarantee that the login remains valid.

退出所选账号、仓库权限撤销或身份不匹配时停止私有读取。恢复等待任务前，会用当前权限重新读取固定 HEAD 和检查；证据变化或不可访问时保持等待，直至能够核对、取消或超时。选择**仅公开仓库**可停用私有访问。“已配置”标记只表示已保存选择，不代表登录永远有效。

## Separate token (advanced) / 独立令牌（高级）

1. Create a separate **fine-grained personal access token**, limited to the repositories you need. Grant **Checks: read**, **Commit statuses: read**, and **Pull requests: read**. Organization approval may be required.
2. Open **Connections → GitHub → Separate token**, or choose token configuration in `namo github configure`. Select exact `owner/repo` names and paired users, then enter the token. Do not paste it into chat or command arguments.
3. Save. Settings take effect on the next wait poll. Run `namo github status` to inspect scopes and credential presence without exposing the token.
4. Start a new Namo workstream if the existing Codex thread predates the external-wait tool. Request a wait for a specific PR, HEAD and check names; Namo does not infer required checks from branch protection.

创建独立的细粒度令牌，只选所需仓库并授予上述三类读取权限。在**连接设置 → GitHub**或本机 `namo github configure` 中填写确切仓库、选择配对用户并隐藏输入令牌。留空保留原凭据；勾选清除后保存才撤销。凭据不回显、不写入浏览器存储，也不接受命令行参数或管道输入。配置保存后在下次轮询采用，`namo github status` 只显示配置状态与范围。

GitHub permission references: [Checks](https://docs.github.com/en/rest/checks/runs), [Commit statuses](https://docs.github.com/en/rest/commits/statuses), [Pull requests](https://docs.github.com/en/rest/pulls/pulls).

## Boundaries / 边界

- Only an explicitly selected user's direct-message task may use private access on `github.com`. Local login binds one user; token mode additionally requires an exact allowed repository. Group chats never use private credentials.
- Local login is opt-in. Without that selection Namo does not use `gh`; neither mode inherits ambient GitHub tokens, Git credential helpers or browser sessions.
- Requests go only to `https://api.github.com`, with no redirects. HTTP errors are reduced to stable codes. Credentials stay outside prompts, wait records, public configuration responses and logs.
- In token mode, local configuration and protected configuration backups contain the token. Replacing or clearing it does not delete historical backups or revoke it at GitHub. Local login stores no token in Namo configuration; protect the host credential store in either case.
- Each private observation is bound to its task, user, chat and authorization scope. Before resuming, Namo checks current settings again. Revoked access leaves the task waiting until authorized again, cancelled or timed out; it never resumes using the old credential's observation.

私有访问仅限明确选择用户的本人私聊，群聊不使用。本机登录需主动选择，独立令牌模式另外限制仓库白名单。令牌模式的配置及备份含凭据，清除配置不会抹除旧备份或撤销 GitHub 上的令牌。权限变化后会重新核对，不直接使用旧观察恢复任务。

For manually managed **foreground** deployments, `github.tokenEnv` may name an explicit `NAMO_GITHUB_*` environment variable instead of `github.token`; the two are mutually exclusive. The variable must exist in the receiving process. The macOS service installer does not copy shell environment variables into launchd. Prefer the local configuration UI or CLI for background services. No GitHub environment variable is forwarded to Codex.

手工管理的**前台**部署可配置 `github.tokenEnv`，仅接受显式 `NAMO_GITHUB_*` 环境变量名，与 `github.token` 二选一。macOS 服务安装不会把终端环境变量复制到 launchd；后台服务建议通过本机 UI/CLI 保存凭据。Codex 子进程不会继承 GitHub 环境凭据。

Configuration, scopes, fake HTTP failures, restart and revocation are covered by local tests. Real private-repository acceptance uses the explicitly selected login or token and is recorded separately from deployment.

本地测试覆盖配置、身份范围、模拟 HTTP 失败、重启与撤销。真实私有仓库验收使用明确选择的本机登录或令牌，并与部署状态分开记录。

On 2026-10-27, local gh login passed real private-PR check-run and commit-status observation, durable wait/resume and Feishu receipt confirmation. See the [delivery record](archive/local-gh-delivery-20261027.md). Separate-token and other live failure scenarios are not implied by that result.

2026-10-27，本机 gh 登录已通过真实私有 PR 的 check run / commit status 读取、持久等待恢复及飞书收件确认。见[交付记录](archive/local-gh-delivery-20261027.md)。这不替代独立令牌或其他真实失败场景的验收。
