# 发布与开发隔离

Namo 后台服务不再直接运行仓库或全局安装目录中的 `dist`。`service install` 会先创建内容寻址的运行快照，再让 launchd 通过独立启动器加载指定快照。之后修改源码、重新构建开发目录或更新其中的 `node_modules`，都不会改变已经运行或下次重启的服务版本。

## 快照内容与身份

快照位于配置对应的 `dataDir/releases/<release-id>/`，包含：

- 编译后的 `dist/src`、`dist/scripts` 和 `dist/ui`；
- CLI 启动文件、运行时图片资源与 `package.json`；
- 从当前安装解析并复制的生产依赖树。

依赖文件会被复制到快照内部，不保留指向开发目录或 pnpm store 的符号链接。`release-id` 是确定性 manifest 的 SHA-256；manifest 记录每个运行文件的相对路径、大小、权限和 SHA-256。创建完成后文件改为只读。后台启动器位于快照外的 `dataDir/service-bootstrap.mjs`，launchd 参数固定预期 release id 和目录。启动器只加载 Node 内置模块，先校验目录身份和全部文件，再动态加载 CLI 与依赖；包括 KeepAlive 自动重启，每次都执行相同校验。启动器及 launchd 登记是本机受信任的启动边界，无法防御拥有同一用户文件写权限者同时改写启动器和系统服务登记。

快照缺失、被修改或登记与 plist 不一致时会拒绝启动。

旧快照不会被自动删除。当前版本也不提供联网更新、依赖安装或通用自动更新器。

## 安装、重启与状态

首次安装：

```sh
namo service install
```

安装会创建快照、写入固定入口并启动服务。`service start` 和 `service restart` 只使用 `dataDir/service.json` 已登记的快照，不会把发出命令的 CLI 路径写回服务元数据。`service stop` 和 `service uninstall` 同样不会改写发布身份。

`namo service status` 中的 `release` 字段分别表示：

- `installed`：服务登记的 release id；
- `running`：匹配当前 PID 的进程自己写入健康文件的 release id；
- `verified`：显式服务状态检查时，登记快照当前是否通过完整文件校验；普通界面轮询可以省略该值；
- `matches`：运行进程与登记版本是否一致。

因此，版本对比不依赖当前执行 `namo status` 的 CLI 来猜测线上版本。前台开发进程没有发布身份，`running` 可以为空。

## 安全升级

升级采用显式维护窗，不会自动停止或自动重新启动接收端：

```sh
namo service stop
namo service status
namo service upgrade
namo service start
```

运行 `upgrade` 前必须满足：

1. launchd 服务已停止，且 `service.lock` 没有活动接收端；
2. 数据库 schema 为当前版本，或发布流程明确支持的上一版（当前支持 6–9 → 10 的增量迁移）；检查过程只读，不提前迁移；
3. inbox 中没有 queued、running、waiting 或 awaiting_reply；
4. 没有 starting、running 或 lost 的独立 runner；
5. 没有 requested 或 open wait；
6. outbox 中没有 pending、sending 或 deferred；
7. 没有其他 maintenance 操作。

任一条件不满足都会保持原 plist 和服务停止状态。尤其是等待用户补充的任务也属于未收敛状态；不能为了升级直接忽略它。先完成、取消或按异常恢复流程核对，再重新运行升级。

如果先卸载服务再对已有 `bot.sqlite` 执行 `service install`，同一组空闲门禁及可验证备份仍然生效；卸载不会成为绕过独立 runner、wait 或 outbox 核对的捷径。检查与发布登记期间会持有 config-edit 配置锁及 receiver 数据锁，支持的服务操作也会串行化，避免另一个前台或后台启动夹在检查和 plist 切换之间。

`upgrade` 通过检查后创建或复用新快照，更新服务登记与 plist，但仍保持停止。随后由操作者明确运行 `start`。配置文件、Codex 隔离认证目录和数据库路径都沿用原值；升级不会启动第二个飞书接收端，也不会迁移或删除这些数据。

如果进程在两个登记文件的原子替换之间异常退出，下一次 `start` 会因登记不一致而失败关闭，而不是猜测版本。服务保持停止，重新运行 `namo service upgrade` 即可收敛登记。

## Worker 一致性

接收端通过当前模块的相对 URL 启动 `runner-worker.js`。由于接收端入口和 worker 都在同一快照内，后续开发构建不能改变新启动 worker 的代码。已经独立运行的 worker 仍由数据库所有权与配置 revision 约束；安全升级门禁要求这些 worker 全部结束或完成核对。

启动回归覆盖清单缺失、错误预期版本、应用模块和生产依赖被修改，验证这些情况下模块顶层代码均未执行。

## 历史验证

已保存的快照隔离、升级及选项恢复记录见[发布历史](archive/release-history.md)与[交付台账](archive/roadmap-delivery.md)。这些记录不代表当前在线状态；现场核对使用上文的 release 身份字段。

### 升级备份硬前置

`service upgrade` 在服务停止、配置及接收端锁持有期间，先使用 Node SQLite backup 创建一致性副本，再检查非空、完整性、外键、schema 与所有表记录的逻辑指纹，并备份原配置、plist、服务登记和 bootstrap。源文件或数据库在复制期间改变也会中止。全部检查通过才写入 `verified.json`，随后才允许创建发布并修改登记。

任何备份错误返回 `upgrade_backup_failed`，不替换发布、登记或 bootstrap，不自动启动服务；外部 shell 即使继续调用 `service start`，仍使用原登记。部分备份保留为 `.pending`，不能作为成功备份。回执只含摘要与本机路径，不输出配置、凭据或数据库正文；不备份个人认证、不自动恢复旧数据库，也不代表支持跨 schema 降级。

## 已有数据的安装保护

`service install` 在发现已有 `bot.sqlite`、`service.json` 或 `service-bootstrap.mjs` 时，先用同一备份校验逻辑保存配置、数据库及尚存服务文件。适用于卸载后重装，也适用于将前台实例数据接入后台服务。卸载已经移除的 plist 不要求存在，备份清单标识 `operation: install`，不会伪造旧 plist。升级路径仍要求原 plist 存在。

安装备份在 `dataDir/backups/install-…/` 完成并写入 `verified.json` 后，才创建发布快照、替换登记和调用 launchd；失败返回 `upgrade_backup_failed`，保留原文件且不启动接收端。首次没有数据或历史登记的安装无需备份。成功结果的 `backup.path` / `backup.verified` 与升级一致。这些检查只证明安装前的数据副本，不代表新版本启动、数据库迁移或真实飞书收件已验收。
