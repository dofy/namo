<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — 一只蜷着尾巴的橙色狐狸" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>住在本地，帮你把事情做完的小狐狸。</strong><br />
面向飞书与 Lark、支持 Codex 和 Claude Code 的自托管 AI 工作伙伴。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">问题反馈</a></p>

Namo 把 AI 助手带进日常工作的对话中。给它发一条消息，或在群里 @ 它，就可以处理文件、运行测试、审查 PR 或整理报告。它在你的机器上工作，并在原会话中回复结果。

## Namo 能做什么

- **在聊天中协作**：通过飞书或 Lark 交代任务、查看进度，在需要时回答它的问题。
- **处理项目工作**：使用你授权的目录和连接服务，包括 GitHub、远程 MCP 和可信的本地 stdio MCP 工具。
- **跟踪工作进展**：在本地工作台查看任务、会话、执行证据和定时任务，管理设置。
- **记住有用的上下文**：按需设置助手档案和范围记忆，在不同对话中使用相关信息。
- **运行在自己的机器上**：任务状态保存在本地，执行使用官方 Codex 或 Claude Code CLI。

Namo 目前处于早期可用阶段，需要你自行托管和维护。后台服务管理目前支持 macOS；其他平台可前台运行，但尚未完成完整平台验收。

## 快速开始

准备 Node.js 24.15 或更高版本、官方 Codex CLI 或 Claude Code 2.1.330 及以上版本，以及启用机器人能力的飞书或 Lark 应用。

```sh
npm install -g @dofy/namo
namo init
```

初始化向导会引导你选择执行器、登录、设置可访问目录并连接机器人。向导支持安装 macOS 后台服务，也可用 `namo start` 前台运行。

运行 `namo ui`，在 **连接设置**启用 Claude Code 或修改默认执行器。使用 Claude 账号时运行 `namo login --profile claude`，使用自定义网关时填写网关 Base URL 和凭据。飞书或 Lark 私聊可用 `/agent claude` 和 `/agent codex` 切换，切回时续接该执行器自己的工作线。

Codex 和 Claude Code 共用同一套按权限读取的长期记忆。Namo 空闲时，由默认执行器自动整理记忆。

开发时可使用 pnpm 12.15.0 从源码构建：

```sh
git clone https://github.com/dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
pnpm cli init
```

## 可选的远程工作台

`namo ui` 默认打开本机工作台。想从其他设备访问时，运行 `namo ui --remote-guide`，把输出交给协助安装的 agent。随包指南包含独立回环监听、HTTPS 反向代理、管理密码，以及桌面和手机登录、退出的验收步骤。[远程工作台配置 Skill](skills/namo-remote-workbench/SKILL.md)

## 连接 Inkflit

在**设置 → 连接设置 → MCP 连接**中选择**添加本地 MCP**：ID 填写 `inkflit`，可执行文件填写 `/Applications/Inkflit.app/Contents/MacOS/Inkflit`，参数填写 `["--mcp"]`，保存后测试连接。也可以在 `namo config` 中配置本地 MCP。Namo 和 Inkflit 需在同一台 Mac 以同一用户运行。请只添加可信程序：它们以 Namo 的系统用户权限运行，所有获准对话的成员都能调用其工具。

## 了解更多

- [文档](docs-site/)：运行 `pnpm cli docs` 打开中英文文档；已安装 CLI 时使用 `namo docs`。
- [技术指南](docs/technical-guide-zh-cn.md)：安装、功能、权限和开发说明。
- [英文文档索引](docs/README.md)：技术实现、运维和开发路线图。
- [问题反馈](https://github.com/dofy/namo/issues)：请勿附上凭据或私密会话内容。
