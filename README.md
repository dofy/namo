<p align="center">
  <img src="assets/namo-logo.png" alt="Namo — an orange fox with a curled tail" width="176" />
</p>

<h1 align="center">Namo</h1>

<p align="center"><strong>A little fox on your machine, helping you get work done.</strong><br />
A self-hosted agent service for Feishu and Lark organizations, powered by Codex.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a><br />
<a href="https://github.com/dofy/namo">GitHub</a> · <a href="https://github.com/dofy/namo/issues">Issues</a> · <a href="docs/development-plan.md">Development plan</a></p>

Namo connects an organization’s chats to an agent running on a workstation or server. Send a direct message or mention the bot in a group to work on a configured project, edit files, run commands and tests, and receive the result in the same conversation.

Namo manages messages, queues, projects, sessions and execution boundaries. The official **Codex app-server** handles reasoning and tools. Code, task state and execution stay on your machine; model inference uses the service associated with your Codex account.

**Status: early access.** Supports organization admission, explicit project grants and configured GitHub access. Real Feishu messaging has been verified, but you maintain the host yourself. No npm package has been published yet.

## What it does

- **Feishu / Lark chat:** persistent connection, direct messages, group mentions, text and basic rich text; organization membership or a selected-member allowlist controls admission.
- **Organization access:** detect the Feishu tenant, admit members without individual pairing, and grant local projects to an organization, selected groups, or selected members in direct messages. Members start in isolated workspaces.
- **Group PR review:** read bounded PR patches with a fixed base/head through a service-side GitHub connection and return findings to the authorized conversation. Missing patches and review limits are explicit; no automatic GitHub comments.
- **Projects and sessions:** work in configured directories, preserve conversation context, switch projects and explicitly resume sessions.
- **Durable tasks:** SQLite inbox and outbox, message deduplication, input revisions, per-chat and per-project serialization, and a global concurrency limit.
- **Questions and answers:** the agent can pause for your input; answer by replying to the question or choosing a matching card option.
- **Independent runners:** active tasks run separately from the receiver. Uncertain or interrupted work is retained for review instead of blindly rerunning it.
- **Execution evidence:** file patches, command exit codes, artifact checks and Git HEAD snapshots, with capture limits made explicit.
- **Assistant and scoped memory:** opt-in assistant identity and style, automatic extraction of sourced long-term facts with scope and privacy controls, explicit correction/disable/delete, and bounded handoffs. Memories never grant operation authority.
- **Materials and artifacts:** bounded reading of merged-forward text and direct UTF-8 text files, plus authorized delivery of selected task files. Direct PNG/JPEG images are passed to Codex as bounded, immutable image inputs.
- **Local workbench:** a dashboard, searchable task and session lists, user/project/status/date filters, pagination, details, profiles, assistant settings, memory review, configuration and connection diagnostics.
- **Concise chat replies:** durable acceptance reactions, original-message/topic routing, safe rich text and a single updatable progress card. Buttons require the Feishu callback subscription.
- **Controlled continuations:** exact-head GitHub check waits (public, or explicitly configured private repositories) can resume the same task without model polling; a limited-protection Git push approval path binds one approval to one task, commit, remote and branch.
- **Local service management:** guided setup, isolated official Codex login, diagnostics, immutable service releases and macOS background service commands.

The workbench and CLI support **English and Simplified Chinese**. They follow the system language by default and fall back to English for unsupported languages. Task content, user input and execution logs retain their original language.

PDF/Office/audio material interpretation, autonomous delegation and offline message backfill remain unsupported. Send `/schedule` in a private Feishu chat to manage scheduled reminders and tasks. See the [roadmap](docs/development-plan.md) for implemented capabilities and remaining acceptance checks; check the workbench for the running service version.

Organization setup: open **Connections** in the workbench to configure organization access and choose a GitHub account and paired owner. Existing installations retain their access rules until an administrator changes them. See [organization access](docs/operations.md#配置与权限).

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

The resumable wizard guides you through Codex detection, isolated login, project permissions, app credentials and user pairing. A live model/messaging check is optional and may use account quota.

To build a local CLI package:

```sh
pnpm pack
npm install -g ./namo-0.2.0.tgz
namo init
```

Existing configuration can be selected with `--config`. Namo also recognizes `NAMO_CONFIG` and an existing `config.local.json` in the current directory. It does not silently move or overwrite existing configuration or data.

```sh
namo --help
namo ui               # Local workbench; does not start another receiver
```

### Language

Use **Language** at the bottom of the workbench sidebar to select **System language**, **English** or **简体中文**. Your choice is remembered across workbench launches on the same browser and loopback host. Switching language preserves current filters and unsaved form input.

CLI priority is `--lang` → `NAMO_LANG` → system language (`LC_ALL`, `LC_MESSAGES`, `LANG`, then the runtime locale). Unsupported system languages fall back to English. `system` explicitly restores automatic selection.

```sh
namo --lang en --help
namo --lang zh-CN init
namo --lang system ui
NAMO_LANG=zh-CN namo ui
```

`--version`, paths and JSON output remain machine-readable; project links appear in help and the workbench sidebar. External agent output and historical records keep their original text.

## Chat commands

Use `/project` to switch projects, `/task` to inspect a task, `/cancel` to stop it, `/new` for a fresh context, `/profile` for your profile, `/status` for service status and versions, `/version` for Namo and Codex CLI versions, and `/help` for available commands. In a private chat, `/model` shows model choices, `/model MODEL_ID` sets your default, and `/model default` follows the service default. The workbench can also set each user's default. Explicit selections are saved with accepted tasks; availability depends on the Codex account.

The workbench’s **Settings → Codex CLI updates** panel provides version checks, manual upgrades, rollback and an automatic update toggle. Automatic upgrades are off by default. While the service runs, enabled updates check the official stable channel daily, defer while busy, and back off for at least an hour after failures. Namo keeps complete private packages in `namo-cli/` under its isolated Codex home, verifies SHA-256, version, app-server handshake, login, permissions and model discovery, then atomically selects the candidate when idle. It preserves the global CLI and model preferences. Rollback disables automatic upgrades. macOS/Linux arm64/x64 are supported. Feishu model discovery refreshes every five minutes and after CLI changes; failed updates retain the selected version. Historical CLI packages are currently retained without automatic cleanup.


See the [command reference (Chinese)](docs/getting-started.md#聊天命令) and [documentation index (Chinese)](docs/README.md) for delivery, memory and approvals.

## Execution boundaries

- The template defaults to read-only access. Use setup or the workbench to grant access to specific project directories, network commands and local Git commits.
- Configuration, runtime data and isolated Codex login files remain excluded from agent access. Do not grant access to your entire home directory to fix a toolchain issue.
- Skills receive read-only access to individual enabled skill directories and canonical symlink targets. Personal Codex skill opt-outs remain disabled in Namo. Run `pnpm run smoke:skills` to check the actual sandbox boundaries; see [skill access](docs/architecture.md#模块与约束).
- Write permission also permits file deletion. Cancellation, timeout or context reset does not undo completed actions.
- Git push approvals bind an exact task, owner/chat, project, configured remote, branch, HEAD SHA, configuration revision and expiry, then allow a single execution attempt. This is **limited protection**, not complete enforcement: a generally networked agent or another credential path could bypass the approval entrypoint. Deployment is not implemented as a generic target.
- OpenClaw import requires an explicitly selected source file, supported version and application. It never imports provider authentication, gateways, plugins or tasks, and it cannot automatically take over a receiver; cutover and rollback remain an explicit, verified manual gate.
- GitHub waits default to anonymous public access. In **Connections → GitHub**, select a local `gh` login and one paired owner: admitted groups get read-only repository access; the owner's private chat can use all account API permissions. Other private chats cannot borrow the account. No repository grant lists are needed; a separate token remains available. CI waits never trigger writes. See [private GitHub setup](docs/operations.md#github-连接).
- A platform send receipt means the platform accepted the message, not that the user read it. Ambiguous sends are retained for review.
- A sleeping or disconnected host cannot provide continuous service. There is no offline history backfill.
- Never commit `config.local.json`, `data/`, logs, tokens or authentication files. Namo does not automatically import personal MCP servers, plugins or third-party model gateways.

The CLI keeps only `init`, `login`, `start`, `service`, and `ui`. Status, logs, diagnostics, and Git push approvals are available in the workbench. Inspect OpenClaw sources under **Connections → Runtime and maintenance**; import with `namo init --import`. Migration never switches receivers automatically. Approvals still bind preconfigured targets and require explicit confirmation. See [OpenClaw migration](docs/operations.md#openclaw-导入) and [Git approvals](docs/operations.md#git-推送审批).

Background service management currently supports macOS. Other systems can use foreground mode but have not completed full platform acceptance. Codex is the only execution backend. Other agents are reserved for future plugins; no additional agent SDKs or probes are included.

## Development

The stack is TypeScript, Node.js built-in SQLite, the official Feishu Node SDK and Codex app-server over stdio. The workbench uses React, Radix Themes and Vite; its compiled assets and fonts are bundled with the CLI.

```sh
pnpm test
pnpm run smoke:codex          # Protocol handshake; no inference
pnpm run smoke:codex -- --run # Explicit real inference test
```

See the [documentation index](docs/README.md), [developer guide](docs/architecture.md#开发与验证), and [remaining work](docs/development-plan.md). Detailed guides are currently in Chinese.

Project: [github.com/dofy/namo](https://github.com/dofy/namo). Report reproducible issues without credentials, private configuration or raw conversation data.
