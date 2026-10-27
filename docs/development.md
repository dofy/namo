# 开发指南

项目约定见根目录 [AGENTS.md](../AGENTS.md)。使用 Node.js 24.15+、固定的 pnpm 12.15.0 和唯一的 pnpm-lock.yaml；安装依赖执行 `pnpm install --frozen-lockfile`，不要生成 npm / Yarn 锁文件。

## 源码与本地 CLI

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

## 验证

```sh
pnpm test
pnpm run smoke:codex
# 明确需要真实推理时，使用机器人的官方独立登录
pnpm run smoke:codex -- --run
```

`pnpm test` 构建 CLI / UI 并运行隔离测试，不代表真实飞书收件通过。smoke 读取实例配置并使用独立 Codex 环境；无权访问配置或认证时应报告未运行，不能借此绕过路径限制。纯文档变更检查链接、锚点、双语入口及事实一致性，不新增镜像实现的测试。

## package.json 脚本

保留 10 个开发和发布流程入口，日常操作统一通过 `pnpm cli <命令>`，不再为登录、启动、状态、初始化和服务管理维护重复别名。

| 脚本 | 用途 |
|---|---|
| `build` | 完整构建服务端与前端 |
| `build:server` | 单独编译 CLI、服务和测试；供其他脚本复用 |
| `build:ui` | 前端类型检查与 Vite 构建 |
| `typecheck:ui` | 只检查浏览器代码类型 |
| `ui:watch` | 前端监听构建 |
| `test` | 构建后运行自动化测试 |
| `smoke:codex` | 官方 app-server 协议、登录和权限握手；`--run` 显式调用模型 |
| `smoke:skills` | 实际 Codex 沙箱的技能读取与写入边界验证 |
| `prepack` | 打包时自动构建，避免漏带资源 |
| `cli` | 从源码目录运行唯一 CLI 入口 |

## 本地打包

`pnpm pack` 生成本地验收包，prepack 会构建，不会发布 npm。分发包含编译资源、字体和文档；核对不含本地配置、数据、认证、日志或临时验收材料。当前 package.json 保持 `private: true`。

开发构建不切换后台服务。快照、维护门禁、升级与回退见[发布隔离](release-isolation.md)；运行故障与核对见[运维](operations.md)。
