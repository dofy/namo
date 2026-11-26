<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — an orange fox with a curled tail" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>A little fox on your machine, helping you get work done.</strong><br />
A self-hosted AI work companion for Feishu and Lark with Codex and Claude Code support.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">Issues</a></p>

Namo brings an AI agent into the conversations where your work happens. Send it a message or mention it in a group to work on files, run tests, review a pull request, or prepare a report. It works on your machine and replies in the same conversation.

## What Namo can do

- **Work from chat.** Give Namo a task in Feishu or Lark, follow its progress, and answer questions when it needs more information.
- **Work with your projects.** Let it use the directories and connected services you authorize, including GitHub, remote MCP services and trusted local stdio MCP tools.
- **Keep track of work.** Review tasks, sessions, execution evidence, schedules and settings in a local workbench.
- **Remember useful context.** Use an optional assistant profile and scoped memory to carry relevant context across conversations.
- **Run on your own machine.** Namo stores task state locally and uses the official Codex or Claude Code CLI for execution.

Namo is an early-access project. You host and maintain the service yourself; background service management currently supports macOS. Other platforms can run in the foreground but have not completed full platform acceptance.

## Get started

You need Node.js 24.15 or newer, either the official Codex CLI or Claude Code 2.1.330 or newer, and a Feishu or Lark app with bot capabilities.

```sh
npm install -g @dofy/namo
namo init
```

The setup wizard lets you choose a backend, sign in, grant directory access and connect your bot. It can install a macOS background service. To run in the foreground, use `namo start`.

Open **Connections** in `namo ui` to enable Claude Code or change the default backend. Use `namo login --profile claude` for Claude account sign-in, or enter a custom gateway’s Base URL and credential. In a Feishu or Lark direct chat, use `/agent claude` and `/agent codex` to switch. Namo resumes each backend’s own workstream when you switch back.

Codex and Claude Code share the same scoped long-term memory. The default backend handles automatic extraction while Namo is idle.

For development, build from source with pnpm 12.15.0:

```sh
git clone https://github.com/dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
pnpm cli init
```

## Optional remote workbench

`namo ui` opens the local workbench by default. To access it from another device, run `namo ui --remote-guide` and give its output to your agent. The bundled setup guide walks through starting a separate loopback listener behind your HTTPS proxy, setting an owner password, and checking sign-in and sign-out on desktop and mobile. [Remote workbench setup skill](skills/namo-remote-workbench/SKILL.md)

## Connect Inkflit

In **Settings → Connections → MCP**, choose **Add local MCP**. Set the ID to `inkflit`, the executable to `/Applications/Inkflit.app/Contents/MacOS/Inkflit`, and arguments to `["--mcp"]`, then save and test. You can also add local MCPs in `namo config`. Namo and Inkflit must run as the same user on the same Mac. Only configure trusted programs: they run with the Namo user’s OS permissions, and all admitted bot users can call their tools.

## Learn more

- [Documentation](docs-site/) — run `pnpm cli docs` to open the bilingual guide (or `namo docs` with an installed CLI).
- [Technical guide](docs/technical-guide.md) — setup, capabilities, permissions and development.
- [Documentation index](docs/README.md) — architecture, operations and roadmap (Chinese).
- [Report an issue](https://github.com/dofy/namo/issues) — please leave out credentials and private conversation data.
