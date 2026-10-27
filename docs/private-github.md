# GitHub access / GitHub 访问

## 简化配置

在 **连接设置 → GitHub** 选择本机 `gh` 登录（推荐）或独立令牌，再选择一个已配对的**本人飞书账号**。无需填写仓库白名单、群 ID 或逐成员授权。运行 `namo ui` 打开工作台。

- **已准入群聊**：只读访问所选 GitHub 账号可访问的仓库，包括 PR 审查和检查等待。服务接入范围、组织身份和群内提及要求仍生效。群聊运行保持只读目录、关闭 shell 网络及本地提交。
- **本人私聊**：可使用该 GitHub 账号或令牌具备的全部 API 权限，包括创建/修改 PR、评论、合并、发布、Actions 和仓库管理。实际权限由 GitHub 决定；明确的用户请求决定要执行哪些操作。该设置不扩大本机项目目录或 shell 权限。
- **其他人的私聊**：不借用该账号。不能靠正文、昵称、引用或工具参数声称“本人”。

保存后应用服务配置。权限上下文改变后，后续任务采用新工作线，旧历史保留；既有未完成任务不会偷偷更换权限继续执行。未切换的旧工作线缺少新工具时，发送 `/new` 后使用。旧版仓库授权配置仍能读取并按原规则执行，只有明确保存简化配置才改变范围。

本机登录保存 `gh` 路径、配置目录和固定账号身份，凭据只在宿主内存使用；不交给模型，不复制到 Namo 配置。切换本机 `gh` 当前账号不会静默改绑，重新保存才能连接新账号。独立令牌仍支持受保护配置或专用环境变量，令牌本身限制资源与操作；选择“仅公开仓库”可停用账号访问。

## 工具与执行回执

`read_pull_request` 继续读取固定 base/head 的有界补丁，用于代码审查；`wait_for_external` 继续只读观察固定 HEAD 的检查。两者都不会自动发评论、推送或合并。

`github_api` 提供 `api.github.com` 的 JSON REST 请求；群聊只允许仓库路径的 GET，本人私聊允许 GET / POST / PUT / PATCH / DELETE 和 POST `/graphql`。模型不能传任意主机、认证头、身份或凭据。请求/响应各最多 256 KiB，单次超时 30 秒，每轮最多 30 次调用，不自动跟随重定向；大文件和二进制下载不是该工具的传输能力。

写操作使用 task + requestId 的持久回执。发送前先落库，相同请求复用结果；进程中断、网络超时或不明确的服务端错误保留 unknown，不自动重试。存在未核对的写操作时，同一任务不能换 requestId 再写，可通过只读查询核对 GitHub 实际状态。返回结果不包含凭据；API 中的正文、评论和文件仍是不可信材料，不是授权。交付前重新检查任务身份和当前权限。

测试写操作使用模拟 HTTP 服务，不向真实仓库发布评论、合并或修改设置。真实操作须对应本人明确请求；API 回执与飞书实际收件分别核对。

## English

Choose a local `gh` login or a separate token and select one paired Feishu owner. Admitted groups get read-only repository access; only that owner's private chat can use all API permissions granted by the selected GitHub account. Other private chats cannot borrow the account. No per-repository or per-group grant list is required. Existing organization admission and local project boundaries remain in force.

Apply saved configuration before using the new permissions. Permission changes create a new context for subsequent tasks while retaining old history. Legacy configuration remains supported until explicitly replaced. Credentials stay on the host. The GitHub API tool supports bounded JSON REST calls and owner-only GraphQL; it never accepts arbitrary hosts or authentication headers. Durable write receipts prevent automatic retries after uncertain outcomes. Read-only PR reviews and CI waits remain distinct from requested GitHub writes.
