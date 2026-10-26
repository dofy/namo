# GitHub PR 检查等待

R5 首批只支持一个条件：等待某个 GitHub Pull Request 的**固定 HEAD SHA**上的一组精确检查进入终态。系统在模型轮次结束后只读轮询；不让模型保持运行，不创建或修改 PR，不重跑检查，也不执行推送、合并或部署。

GitHub 官方接口事实：

- [Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) 返回 PR 的 `head.sha`，公开仓库可以不认证读取。
- [List check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference) 可按固定 commit SHA、`check_name`、`app_id` 和 `filter=latest` 读取 check run；公开仓库可以不认证读取。
- [Get the combined status for a specific reference](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference) 返回固定 commit 的 commit status contexts。
- GitHub 对 required status checks 使用 context，并可绑定 GitHub App ID；读取分支保护配置需要额外的 Administration read 权限，见 [Protected branches REST API](https://docs.github.com/en/rest/branches/branch-protection#get-status-checks-protection)。因此首批不会在无权限时猜测“哪些检查是 required”，而是把调用方提供且已审阅的精确选择器固定进等待记录。
- GitHub 将 `successful`、`skipped` 或 `neutral` 视为允许通过 required status check 的终态，见 [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。

## 持久状态与身份绑定

`ExternalWaits` 使用现有 `settings` 表中的 `external-wait:<id>` JSON 记录，不改变数据库 schema。每条记录固定绑定：

- task ID、run ID、Codex thread / turn / tool call；
- 已验证的 Namo owner ID 与实际 delivery chat ID；
- GitHub owner、repo、PR number 和 40 位小写 HEAD SHA；
- 1–20 个精确检查选择器；
- 创建、更新、到期时间和状态修订号。

check run 选择器必须包含 `context + appId`；commit status 选择器包含精确 context。两类不会互相代替。创建等待时会再次核对 task / run 正在运行，owner、chat、thread 和 turn 都来自持久任务记录，而不是模型参数或网页内容。

状态如下：

- `open`：继续由系统轮询；pending、缺失、歧义、API 错误和未知值都留在此状态。
- `ready`：PR 已关闭，或 PR 仍打开且每个固定检查都已进入明确 passing / failing 终态。
- `stale_head`：PR 当前 HEAD 不再等于固定 SHA。该状态不会唤醒原任务。
- `timed_out` / `cancelled`：到期或由匹配的 task owner/chat 取消，不会被迟到结果恢复。
- `consumed`：恢复结果已经和下一个持久工作项在同一事务内提交，只能消费一次。

失败检查也会产生 `ready`，因为“CI 明确失败”是需要原任务处理的已知结果；`unknown` 永远不会伪装成完成。轮询响应带修订号，旧响应、重复响应及终态后的迟到响应不能覆盖新状态。

## Dynamic tool 接线

```ts
const registration = externalWaitToolRegistration(
  new ExternalWaits(store),
  { taskId, runId, threadId, turnId, callId, ownerId, chatId }, // 系统元数据
);

registration.definition; // 传给 Codex app-server dynamicTools
EXTERNAL_WAIT_INSTRUCTIONS; // 追加到受控 developer instructions
registration.handle(toolArguments); // 在向模型 ACK 前同步持久化
```

模型参数只包含 GitHub 目标、固定 HEAD、检查选择器和 1 分钟至 7 天的超时；不能传 task、owner、chat 或认证信息。成功持久化后应中断当前模型轮次，并由 Engine 将任务停在外部等待状态。不要同时暴露 `wait_for_user` 来冒充 CI 等待。

CLI / receiver 启动和周期调度调用：

```ts
const waits = new ExternalWaits(store);
const adapter = new GitHubRestAdapter({ token }); // token 可省略
await waits.pollOpen(adapter); // 默认每批最多 4 条，单条观察共享 15 秒期限

for (const wait of waits.ready()) {
  waits.consume(wait.id, binding, result => {
    // 这里只能进行同一 SQLite 事务内的持久恢复入队，不能调用模型或网络。
    enqueueExternalResume(result);
  });
}
```

`consume` 的回调和 `ready -> consumed` 在同一 Store transaction 内执行。回调失败会整体回滚；进程重启后仍能看到 `ready` 并重试。提交成功后重复消费返回空，不会产生第二次模型运行。

恢复 payload 明确标注 `source: github_rest` 与 `authorization: false`。它是系统只读证据，不是用户回答，不授予推送、合并、部署、发送消息或扩大权限的授权。

## GitHub REST 适配器

`GitHubRestAdapter`：

- 只向固定的 `https://api.github.com` 发 GET 请求，不接受任意 API base URL，不执行 `gh`，也不读取主机的 GitHub 登录。
- 默认不认证，适用于公开仓库；私有仓库可由受保护配置在进程内注入 token。token 不进入等待记录、错误或日志。
- 先读取 PR HEAD，再读取固定 SHA 上的 exact check runs / commit statuses，最后再次读取 PR HEAD，缩小检查期间换 HEAD 的竞态窗口。
- 单请求 15 秒总期限、响应体默认 2 MB 上限；禁止重定向；HTTP、格式、限流与网络错误只输出有限错误码。
- check run 同名同 app 返回多条、commit status context 返回多条、检查缺失或平台返回未知状态时全部 fail closed 为 `unknown`。

持续离线、GitHub 限流或 token 权限不足时，系统不能保证按时观察到结果；等待只会保持 open 直到下次轮询或超时。平台 API 成功、Namo 已持久化 ready、恢复任务已消费和最终消息已送达仍是四个不同事实。
