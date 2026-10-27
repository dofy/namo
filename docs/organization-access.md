# Organization service / 组织服务

Namo is a self-hosted bridge between a Feishu organization and an agent. The host may be a workstation or server. Connecting a service credential and granting access to its resources are separate decisions.

Namo 是面向飞书组织的自托管 Agent 服务。工作站和服务器都是部署载体；连接服务凭据与授权共享资源分别配置。

## Contract / 契约

- Organization mode admits verified user events from one explicitly configured tenant. External tenants, missing tenant identity and bot senders are rejected. The Feishu app's availability and optional chat restriction still apply. Legacy paired mode remains compatible; upgrades never silently enable organization access.
- 组织模式只接收明确配置组织的已验证用户事件；外部组织、缺失组织身份和机器人发送者被拒绝。飞书应用可用范围和可选聊天限制仍生效。旧配对模式保持兼容，升级不自动扩大使用范围。
- Resources use explicit audiences: organization, selected users in direct messages, or selected groups. A user's direct-message grant never grants disclosure to a group. Service credentials stay on the host.
- 资源按整个组织、指定成员私聊或指定群授权；个人私聊权限不隐含群披露权限。服务凭据只留在宿主服务。
- Organization members start in isolated workspaces. Local projects require explicit grants, read-only by default; global extra read paths are not inherited. Task ownership, conversation/thread isolation and concurrency limits remain enforced.
- 组织成员默认使用隔离工作区。本机项目需明确授权，默认只读；不继承全局额外读取路径。任务归属、聊天 / 话题隔离和并发限制继续执行。
- PR review uses bounded GitHub REST reads at a stable base/head, never credential handoff or a repository clone. Missing/truncated patches and changed HEAD are explicit. Repository text is untrusted material. Replies identify the reviewed commit, findings and coverage limits; no automatic GitHub comments, push, merge or deployment.
- PR 审查以固定 base/head 有界读取 GitHub REST，不交付凭据、不克隆仓库。缺失 / 截断补丁和 HEAD 变化须明确报告。仓库文字是不可信材料。回复包含提交、发现和覆盖范围，不自动发 GitHub 评论、推送、合并或部署。

Implementation: organization admission, explicit project/repository audiences, bounded PR review, revocation checks and bilingual UI/CLI. Automated regression and isolated browser checks passed; deployment and live group acceptance are tracked separately.

实现：组织准入、项目 / 仓库显式授权、有界 PR 审查、撤权校验和中英文 UI / CLI。自动回归和隔离浏览器检查通过；部署和真实群聊验收分别记录。

Deployment: the existing local service was upgraded with schema 10 and preserved records/credentials. Organization admission and one explicitly authorized group/repository grant are active. Live group execution, platform readback and recipient display confirmation passed for the selected path; see [delivery evidence](archive/organization-review-delivery-20261027.md).

部署：现有本机服务已升级，保持 schema 10，历史数据和凭据保留；已启用组织准入和一个明确授权的群 / 仓库范围。指定场景的真实群聊执行、平台读回与收件人显示确认均已通过。

Existing sessions retain their project binding. If that project is no longer granted to the chat, Namo refuses continuation; send `/new` and repeat the request to start in an isolated workspace. This does not grant access or copy the old native session.

旧会话保留项目绑定；若该项目已不再向当前聊天授权，Namo 拒绝续接。发送 `/new` 后重发请求，即可开始隔离会话；不会因此扩大权限或复制旧会话上下文。
