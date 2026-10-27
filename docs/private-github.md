# Private GitHub checks / 私有 GitHub 检查

Namo can wait for checks on a private pull request at one fixed HEAD. This is read-only access for the external-wait feature; it does not clone repositories, grant the model GitHub credentials, or authorize a push, merge or deployment.

Namo 可以等待私有 PR 固定 HEAD 的检查结果。本功能只读，不代表支持私有仓库克隆，也不会把凭据交给模型或授予推送、合并、部署权限。

## Setup / 配置

1. Create a separate **fine-grained personal access token**, limited to the repositories you need. Grant **Checks: read**, **Commit statuses: read**, and **Pull requests: read**. Organization approval may be required.
2. Open **Connections → GitHub**, or run `namo github configure` in a local interactive terminal. Select exact `owner/repo` names and paired users, then enter the token. Do not paste it into chat or command arguments.
3. Save. Settings take effect on the next wait poll. Run `namo github status` to inspect scopes and credential presence without exposing the token.
4. Start a new Namo workstream if the existing Codex thread predates the external-wait tool. Request a wait for a specific PR, HEAD and check names; Namo does not infer required checks from branch protection.

创建独立的细粒度令牌，只选所需仓库并授予上述三类读取权限。在**连接设置 → GitHub**或本机 `namo github configure` 中填写确切仓库、选择配对用户并隐藏输入令牌。留空保留原凭据；勾选清除后保存才撤销。凭据不回显、不写入浏览器存储，也不接受命令行参数或管道输入。配置保存后在下次轮询采用，`namo github status` 只显示配置状态与范围。

GitHub permission references: [Checks](https://docs.github.com/en/rest/checks/runs), [Commit statuses](https://docs.github.com/en/rest/commits/statuses), [Pull requests](https://docs.github.com/en/rest/pulls/pulls).

## Boundaries / 边界

- Only an allowed user's direct-message task may use the private credential, and only for an exact allowed repository on `github.com`. Group chats never use it. Other repositories remain anonymous.
- Namo uses only its explicitly configured credential. It does not reuse `gh`, `GH_TOKEN`, Git credential helpers or the user's browser login.
- Requests go only to `https://api.github.com`, with no redirects. HTTP errors are reduced to stable codes. Credentials stay outside prompts, wait records, public configuration responses and logs.
- Local configuration and protected configuration backups contain the token. Protect the host and backups. Replacing or clearing a token does not delete historical backups or revoke the token at GitHub; use GitHub to revoke it there.
- Each private observation is bound to its task, user, chat and authorization scope. Before resuming, Namo checks current settings again. Revoked access leaves the task waiting until authorized again, cancelled or timed out; it never resumes using the old credential's observation.

私有凭据只用于授权用户的本人私聊和白名单仓库；群聊不使用。不会自动读取主机 GitHub 登录。配置文件及受保护的配置备份含凭据，清除当前配置不会抹除备份或撤销 GitHub 上的令牌。撤销用户、仓库或替换令牌后，旧观察记录不能直接恢复任务；可重新授权、取消或等待超时。

For manually managed **foreground** deployments, `github.tokenEnv` may name an explicit `NAMO_GITHUB_*` environment variable instead of `github.token`; the two are mutually exclusive. The variable must exist in the receiving process. The macOS service installer does not copy shell environment variables into launchd. Prefer the local configuration UI or CLI for background services. No GitHub environment variable is forwarded to Codex.

手工管理的**前台**部署可配置 `github.tokenEnv`，仅接受显式 `NAMO_GITHUB_*` 环境变量名，与 `github.token` 二选一。macOS 服务安装不会把终端环境变量复制到 launchd；后台服务建议通过本机 UI/CLI 保存凭据。Codex 子进程不会继承 GitHub 环境凭据。

Configuration, scopes, fake HTTP failures, restart and revocation are covered by local tests. A real private-repository check requires the owner to configure a suitable token locally and remains a separate acceptance step.

本地测试覆盖配置、身份范围、模拟 HTTP 失败、重启与撤销。真实私有仓库验收需所有者在本机配置令牌后另行执行。
