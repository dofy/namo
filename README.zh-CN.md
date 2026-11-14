<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — 一只蜷着尾巴的橙色狐狸" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>住在本地，帮你把事情做完的小狐狸。</strong><br />
面向飞书与 Lark、由 Codex 驱动的自托管 AI 工作伙伴。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">问题反馈</a></p>

Namo 把 AI 助手带进日常工作的对话中。给它发一条消息，或在群里 @ 它，就可以处理文件、运行测试、审查 PR 或整理报告。它在你的机器上工作，并在原会话中回复结果。

## Namo 能做什么

- **在聊天中协作**：通过飞书或 Lark 交代任务、查看进度，在需要时回答它的问题。
- **处理项目工作**：使用你授权的目录和连接服务，包括 GitHub 与远程 MCP 工具。
- **跟踪工作进展**：在本地工作台查看任务、会话、执行证据和定时任务，管理设置。
- **记住有用的上下文**：按需设置助手档案和范围记忆，在不同对话中使用相关信息。
- **运行在自己的机器上**：任务状态保存在本地，模型推理使用官方 Codex 服务。

Namo 目前处于早期可用阶段，需要你自行托管和维护。后台服务管理目前支持 macOS；其他平台可前台运行，但尚未完成完整平台验收。

## 快速开始

准备 Node.js 24.15 或更高版本、pnpm 12.15.0、官方 Codex CLI，以及启用机器人能力的飞书或 Lark 应用。Namo 尚未发布到 npm，可先从源码开始：

```sh
git clone https://github.com/dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
pnpm cli init
```

初始化向导会引导你登录 Codex、设置可访问目录并连接机器人。向导支持安装 macOS 后台服务；如果没有安装，可用 `pnpm cli start` 前台运行。使用 `pnpm cli ui` 打开本地工作台。

要在任意目录使用 `namo` 命令，运行 `pnpm pack`，再运行 `npm install -g ./namo-0.6.1.tgz`。之后可直接使用 `namo init`、`namo ui` 和 `namo docs`。

## 了解更多

- [文档](docs-site/)：运行 `pnpm cli docs` 打开中英文文档；已安装 CLI 时使用 `namo docs`。
- [技术指南](docs/technical-guide-zh-cn.md)：安装、功能、权限和开发说明。
- [文档索引](docs/README.md)：技术实现、运维和开发路线图。
- [问题反馈](https://github.com/dofy/namo/issues)：请勿附上凭据或私密会话内容。
