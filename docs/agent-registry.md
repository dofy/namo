# 执行器注册表（R7.1）

Namo 可保存多个执行器配置（profile）。当前生产适配器仍只有 Codex；Claude 和 Cursor 可以预登记并运行只读探针，真正接管任务分别属于 R7.2 / R7.3。安装、协议握手、登录、真实推理、任务可运行是不同状态。

## 配置与操作

原有配置完全可用：不必增加 `agents`，内置 `codex` profile 继续使用原 `codex.bin/home/model`、权限和项目配置。R7.1 不复制认证、不修改旧配置文件、不自动升级或重启正在运行的服务。

可通过工作台“连接设置 → Agent 配置”编辑，也可向现有配置增加以下非敏感字段：

```json
{
  "agents": {
    "defaultProfile": "codex",
    "memoryProfile": "codex",
    "profiles": {
      "review": { "adapter": "codex", "enabled": true },
      "claude-local": { "adapter": "claude", "enabled": true },
      "cursor-local": { "adapter": "cursor", "enabled": true }
    }
  }
}
```

自定义项支持 `adapter/enabled/bin/model/timeoutMs`。`bin` 可为完整路径或命令名，`model` 留空采用该执行器默认值，超时范围 1000–7200000 ms。不能填写 token、环境变量、网关地址或任意认证目录。内置 `codex` 保留原 `codex.home`；其他 profile 状态目录固定为 `<dataDir>/agents/<profileId>`，所有 profile 共享已配置的项目和权限上限。注册配置不会自动安装执行器或导入个人 hooks、插件及认证。

```sh
namo agent list
namo agent profiles --json
namo agent probe --profile review --json
namo login --profile review
namo agent test --profile review --live
namo agent use --profile review
```

`probe` 不调用模型；`test --live` 会调用模型并使用所选账号额度。R7.1 的 `login/test/use` 仅接受可运行的 Codex profile。Claude/Cursor 探针可以读取明确的专用 profile 状态，不能凭握手成功开启运行适配器；各版本证据见[兼容性基线](agent-compatibility.md)。

保存和应用分开：`agent use` 和 UI 保存不会重启。受控重启后，新默认只作用于**新工作线**；现有工作线保持绑定。在飞书使用 `/new` 才建立采用新默认的工作线。单次任务改派、飞书选择执行器、跨 Agent 交接留在 R7.4。

后台自动记忆提取固定为内置 `codex`，在 CLI 和 UI 单独展示。前台改用其他 Codex profile，不会改变记忆提取的账号或模型。

## 持久化与恢复边界

schema 10 新增 `execution_bindings`，按 task/workstream ID 保存 `{profileId, adapter, revision}`。其中 revision 覆盖命令、模型、状态目录、超时和启用状态；任务原有 `policyHash` 继续记录权限摘要。快照不保存 token 或认证文件。

- 受理任务时，在同一 SQLite 事务中写入任务和选择快照，再确认飞书受理。修改默认值不会改派排队、运行、等待任务。
- worker 按任务快照解析运行工厂，重新校验配置版本、选定 profile、项目路径和权限。选定 profile 被删除、禁用或修改时失败并显示原因；没有自动 fallback 或重放。需要采用新设置时明确新建工作线。
- 已启动的独立 worker 继续使用启动时的配置；重连接收端只观察原运行。禁用 profile 不是杀死正在执行的进程，停止仍须使用任务取消。
- 无快照的旧任务和工作线始终属于内置 `codex`，即使管理员已改默认值。旧 policy hash 和 `workstream:<id>` session key 保持字节兼容。
- 新 profile 使用包含 adapter、profile ID、revision、workstream 的 session key；不把旧原生 thread ID 交给另一 profile。等待请求以全局唯一 run ID 归属，允许不同实例返回相同的原生 thread/turn/call ID。
- 旧材料仍保持原项目和权限绑定；新增非默认 profile 材料同时绑定执行器选择，不能随默认修改迁移。
- 同聊天串行、同目录及父子目录互斥、全局并发上限、证据与 Git 审批、投递规则保持不变。权限检查继续失败关闭。

schema 升级只由新接收服务在受控升级时执行。管理界面只读旧库，不静默迁移；旧版 schema 8 / 9 程序不能直接打开 schema 10 数据。回退不能覆盖升级后产生的新数据。开发与兼容性测试在隔离 worktree/临时库进行；用户授权的本机升级须先演练迁移、备份并核对历史数据，实际交付见[升级记录](archive/r7-registry-delivery-20261027.md)。

## 验证范围

自动回归覆盖旧库迁移与原生 session 保留、多 profile 状态目录与工厂选取、默认更改后任务不改派、profile 撤销、命名空间碰撞、等待归属、CLI/UI 配置校验与乐观锁。只读探针分别验证版本、协议和认证，不以 fixture 宣称供应商实测通过。
