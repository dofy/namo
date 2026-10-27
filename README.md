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

**Status: early access.** Supports organization admission with explicit project and repository grants. Real Feishu messaging has been verified, but you maintain the host yourself. No npm package has been published yet.

## What it does

- **Feishu / Lark chat:** persistent connection, direct messages, group mentions, text and basic rich text; organization membership or a selected-member allowlist controls admission.
- **Organization access:** detect the Feishu tenant, admit members without individual pairing, and grant local projects or GitHub repositories to an organization, selected groups, or selected members in direct messages. Members start in isolated workspaces.
- **Group PR review:** read bounded PR patches with a fixed base/head through a service-side GitHub connection and return findings to the authorized conversation. Missing patches and review limits are explicit; no automatic GitHub comments.
- **Projects and sessions:** work in configured directories, preserve conversation context, switch projects and explicitly resume sessions.
- **Durable tasks:** SQLite inbox and outbox, message deduplication, input revisions, per-chat and per-project serialization, and a global concurrency limit.
- **Questions and answers:** the agent can pause for your input; answer by replying to the question or choosing a matching card option.
- **Independent runners:** active tasks run separately from the receiver. Uncertain or interrupted work is retained for review instead of blindly rerunning it.
- **Execution evidence:** file patches, command exit codes, artifact checks and Git HEAD snapshots, with capture limits made explicit.
- **Assistant and scoped memory:** opt-in assistant identity and style, versioned owner/project/chat memories, explicit correction/disable/delete, and bounded handoffs. Memories never grant operation authority.
- **Materials and artifacts:** bounded reading of merged-forward text and direct UTF-8 text files, plus authorized delivery of selected task files. Direct PNG/JPEG images are passed to Codex as bounded, immutable image inputs.
- **Local workbench:** a dashboard, searchable task and session lists, user/project/status/date filters, pagination, details, profiles, assistant settings, memory review, configuration and connection diagnostics.
- **Concise chat replies:** durable acceptance reactions, original-message/topic routing, safe rich text and a single updatable progress card. Buttons require the Feishu callback subscription.
- **Controlled continuations:** exact-head GitHub check waits (public, or explicitly configured private repositories) can resume the same task without model polling; a limited-protection Git push approval path binds one approval to one task, commit, remote and branch.
- **Local service management:** guided setup, isolated official Codex login, diagnostics, immutable service releases and macOS background service commands.

The workbench and CLI support **English and Simplified Chinese**. They follow the system language by default and fall back to English for unsupported languages. Task content, user input and execution logs retain their original language.

Schema 8 includes the roadmap integrations above and has passed review and deployment on the maintained local instance. Existing installations require an explicit service upgrade. PDF/Office/audio material interpretation, reminders, background delegation and offline message backfill remain unsupported. See the [development plan](docs/development-plan.md) for deployment status and outstanding real-world acceptance checks.

Organization setup: use `namo access configure`, then configure shared repositories with `namo github configure`, or use **Connections** in the workbench. Existing installations retain their access rules until an administrator changes them. See [organization access](docs/organization-access.md).

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

Use `/project` to switch projects, `/task` to inspect a task, `/cancel` to stop it, `/new` for a fresh context, `/profile` for your profile, and `/help` for available commands.

See the [command reference (Chinese)](docs/getting-started.md#聊天命令) and [documentation index (Chinese)](docs/README.md) for delivery, memory and approvals.

## Execution boundaries

- The template defaults to read-only access. Use setup or the workbench to grant access to specific project directories, network commands and local Git commits.
- Configuration, runtime data and isolated Codex login files remain excluded from agent access. Do not grant access to your entire home directory to fix a toolchain issue.
- Write permission also permits file deletion. Cancellation, timeout or context reset does not undo completed actions.
- Git push approvals bind an exact task, owner/chat, project, configured remote, branch, HEAD SHA, configuration revision and expiry, then allow a single execution attempt. This is **limited protection**, not complete enforcement: a generally networked agent or another credential path could bypass the approval entrypoint. Deployment is not implemented as a generic target.
- OpenClaw import requires an explicitly selected source file, supported version and application. It never imports provider authentication, gateways, plugins or tasks, and it cannot automatically take over a receiver; cutover and rollback remain an explicit, verified manual gate.
- GitHub waits default to anonymous public access. In **Connections → GitHub** or `namo github configure`, opt into the local `gh` login for one paired user's direct messages; no separate token or repository allowlist is needed. A separate scoped token remains available. Check access never authorizes Git pushes. See [private GitHub setup](docs/private-github.md).
- A platform send receipt means the platform accepted the message, not that the user read it. Ambiguous sends are retained for review.
- A sleeping or disconnected host cannot provide continuous service. There is no offline history backfill.
- Never commit `config.local.json`, `data/`, logs, tokens or authentication files. Namo does not automatically import personal MCP servers, plugins or third-party model gateways.

Local-only administration also provides `namo migrate`, `namo migrate inspect … --json`, and `namo approval request|inspect|approve|reject|execute|reconcile …`. Migration never switches receivers automatically. Approval targets must already exist in `gitApprovals`; approve, execute and reconcile use explicit confirmation where required. See the [OpenClaw migration](docs/openclaw-migration.md) and [Git approval](docs/approvals.md) documents.

Background service management currently supports macOS. Other systems can use foreground mode but have not completed full platform acceptance. Claude Code and OpenClaw are detected but are not supported execution backends.

## Development

The stack is TypeScript, Node.js built-in SQLite, the official Feishu Node SDK and Codex app-server over stdio. The workbench uses React, Radix Themes and Vite; its compiled assets and fonts are bundled with the CLI.

```sh
pnpm test
pnpm run smoke:codex          # Protocol handshake; no inference
pnpm run smoke:codex -- --run # Explicit real inference test
```

See the [documentation index](docs/README.md), [developer guide](docs/development.md), and [remaining work](docs/development-plan.md). Detailed guides are currently in Chinese.

Project: [github.com/dofy/namo](https://github.com/dofy/namo). Report reproducible issues without credentials, private configuration or raw conversation data.
