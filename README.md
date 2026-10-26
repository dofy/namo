<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — an orange fox with a curled tail" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>A little fox on your machine, helping you get work done.</strong><br />
A local-first AI work companion for Feishu, Lark and Codex.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">Issues</a> · <a href="docs/development-plan.md">Development plan</a></p>

Namo connects chat to your local development environment. Send a direct message or mention the bot in a group to work on a configured project, edit files, run commands and tests, and receive the result in the same conversation.

Namo manages messages, queues, projects, sessions and execution boundaries. The official **Codex app-server** handles reasoning and tools. Code, task state and execution stay on your machine; model inference uses the service associated with your Codex account.

**Status: early access.** Intended for individuals and small groups of trusted users. Real Feishu messaging has been verified, but you maintain the host yourself. No npm package has been published yet.

## What it does

- **Feishu / Lark chat:** persistent connection, direct messages, group mentions, text and basic rich text; one-time pairing and a user allowlist control access.
- **Projects and sessions:** work in configured directories, preserve conversation context, switch projects and explicitly resume sessions.
- **Durable tasks:** SQLite inbox and outbox, message deduplication, input revisions, per-chat and per-project serialization, and a global concurrency limit.
- **Questions and answers:** the agent can pause for your input; answer by replying to the question or choosing a matching card option.
- **Independent runners:** active tasks run separately from the receiver. Uncertain or interrupted work is retained for review instead of blindly rerunning it.
- **Execution evidence:** file patches, command exit codes, artifact checks and Git HEAD snapshots, with capture limits made explicit.
- **Local workbench:** a dashboard, searchable task and session lists, user/project/status/date filters, pagination, details, profiles, settings and connection diagnostics.
- **Concise chat replies:** ordinary answers arrive as text; optional task cards provide details and stop actions. Buttons require the Feishu callback subscription.
- **Local service management:** guided setup, isolated official Codex login, diagnostics, immutable service releases and macOS background service commands.

The workbench and CLI support **English and Simplified Chinese**. They follow the system language by default and fall back to English for unsupported languages. Task content, user input and execution logs retain their original language.

Image/file/voice interpretation, streaming cards, reminders, background delegation, long-term memory and offline message backfill are not implemented. See the [development plan](docs/development-plan.md) for milestones and outstanding real-world acceptance checks.

## Get started

Requirements: **Node.js 24.15+**, the official Codex CLI and a Feishu or Lark internal app with bot capabilities. Use the official Codex authentication and provider.

Until a package is published, build from source with **pnpm 12.15.0**:

```sh
git clone https://github.com/dofy/namo.git
cd namo
pnpm install --frozen-lockfile
pnpm run build
pnpm cli init
```

The resumable wizard guides you through agent detection, isolated login, project permissions, app credentials and user pairing. A live model/messaging check is optional and may use account quota.

To build a local CLI package:

```sh
pnpm pack
npm install -g ./namo-0.1.0.tgz
namo init
```

Existing configuration can be selected with `--config`. Namo also recognizes `NAMO_CONFIG` and an existing `config.local.json` in the current directory. It does not silently move or overwrite existing configuration or data.

```sh
namo --help
namo agent list
namo doctor           # Environment and connection checks; no model inference
namo doctor --live    # Explicit real model test; may use account quota
namo status
namo logs
namo ui               # Local workbench; does not start another receiver
```

### Language

Use **Language** at the bottom of the workbench sidebar to select **System language**, **English** or **简体中文**. Your choice is remembered across workbench launches on the same browser and loopback host. Switching language preserves current filters and unsaved form input.

CLI priority is `--lang` → `NAMO_LANG` → system language (`LC_ALL`, `LC_MESSAGES`, `LANG`, then the runtime locale). Unsupported system languages fall back to English. `system` explicitly restores automatic selection.

```sh
namo --lang en --help
namo --lang zh-CN init
namo --lang system doctor
NAMO_LANG=zh-CN namo doctor
```

`--version`, paths and JSON output remain machine-readable; project links appear in help and the workbench sidebar. External agent output and historical records keep their original text.

## Chat commands

| Command | Purpose |
| --- | --- |
| `/project [name]` | List projects or switch project and start a new context |
| `/status` | Show queue, directory and permission status |
| `/tasks`, `/task N-ID` | View your tasks in the current chat |
| `/material text` | Hold supporting material for up to ten minutes without executing it |
| `/run request` | Start work with pending material; ordinary messages can also start tasks |
| `/amend N-ID text` | Add input to a task; replying to your task message also works |
| `/cancel [N-ID]` | Stop your task; without an ID, target your task in the current topic |
| `/session [W-ID]` | Inspect or select a session and resume its agent context |
| `/new`, `/reset` | Start a new context while preserving files and task history |
| `/resume WAIT-ID answer` | Answer a waiting question; a quoted reply or card choice also works |
| `/profile` | View and manage your basic profile in a direct message |
| `/issues`, `/issue ID` | Inspect execution or delivery issues and follow the returned review instructions |
| `/whoami`, `/help` | Show your chat identity or available commands |

## Execution boundaries

- The template defaults to read-only access. Use setup or the workbench to grant access to specific project directories, network commands and local Git commits.
- Configuration, runtime data and isolated Codex login files remain excluded from agent access. Do not grant access to your entire home directory to fix a toolchain issue.
- Write permission also permits file deletion. Cancellation, timeout or context reset does not undo completed actions.
- Pushes and deployments require explicit confirmation through agent instructions. An enforced command-level approval gate is not implemented yet.
- A platform send receipt means the platform accepted the message, not that the user read it. Ambiguous sends are retained for review.
- A sleeping or disconnected host cannot provide continuous service. There is no offline history backfill.
- Never commit `config.local.json`, `data/`, logs, tokens or authentication files. Namo does not automatically import personal MCP servers, plugins or third-party model gateways.

Background service management currently supports macOS. Other systems can use foreground mode but have not completed full platform acceptance. Claude Code and OpenClaw are detected but are not supported execution backends.

## Development

The stack is TypeScript, Node.js built-in SQLite, the official Feishu Node SDK and Codex app-server over stdio. The workbench uses React, Radix Themes and Vite; its compiled assets and fonts are bundled with the CLI.

```sh
pnpm test
pnpm run smoke:codex          # Protocol handshake; no inference
pnpm run smoke:codex -- --run # Explicit real inference test
```

Detailed engineering and operations documents are currently in Chinese:

- [First-time setup and frontend development](docs/getting-started.md)
- [Configuration and operations](docs/operations.md)
- [Architecture](docs/architecture.md) and [development plan](docs/development-plan.md)
- [Execution evidence](docs/result-evidence.md), [independent runners](docs/runner.md), [waiting and resuming](docs/waits.md)
- [Release isolation](docs/release-isolation.md) and [brand assets](docs/brand.md)

Project: [github.com/dofy/namo](https://github.com/dofy/namo). Report reproducible issues without credentials, private configuration or raw conversation data.
