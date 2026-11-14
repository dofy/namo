<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — an orange fox with a curled tail" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>A little fox on your machine, helping you get work done.</strong><br />
A self-hosted AI work companion for Feishu and Lark, powered by Codex.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">Issues</a></p>

Namo brings an AI agent into the conversations where your work happens. Send it a message or mention it in a group to work on files, run tests, review a pull request, or prepare a report. It works on your machine and replies in the same conversation.

## What Namo can do

- **Work from chat.** Give Namo a task in Feishu or Lark, follow its progress, and answer questions when it needs more information.
- **Work with your projects.** Let it use the directories and connected services you authorize, including GitHub and remote MCP tools.
- **Keep track of work.** Review tasks, sessions, execution evidence, schedules and settings in a local workbench.
- **Remember useful context.** Use an optional assistant profile and scoped memory to carry relevant context across conversations.
- **Run on your own machine.** Namo stores task state locally and uses the official Codex service for model inference.

Namo is an early-access project. You host and maintain the service yourself; background service management currently supports macOS. Other platforms can run in the foreground but have not completed full platform acceptance.

## Get started

You need Node.js 24.15 or newer, pnpm 12.15.0, the official Codex CLI, and a Feishu or Lark app with bot capabilities. Namo is not yet published on npm, so start from source:

```sh
git clone https://github.com/dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
pnpm cli init
```

The setup wizard guides you through Codex login, directory access and connecting your bot. It can install a macOS background service; otherwise, use `pnpm cli start` to run in the foreground. Open the local workbench with `pnpm cli ui`.

To use `namo` outside the repository, run `pnpm pack` followed by `npm install -g ./namo-0.6.1.tgz`. You can then use `namo init`, `namo ui` and `namo docs` directly.

## Learn more

- [Documentation](docs-site/) — run `pnpm cli docs` to open the bilingual guide (or `namo docs` with an installed CLI).
- [Technical guide](docs/technical-guide.md) — setup, capabilities, permissions and development.
- [Documentation index](docs/README.md) — architecture, operations and roadmap (Chinese).
- [Report an issue](https://github.com/dofy/namo/issues) — please leave out credentials and private conversation data.
