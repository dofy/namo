# Namo technical guide

[简体中文](technical-guide-zh-cn.md) · [Product overview](../README.md)

This guide covers setup, capabilities, operation and execution boundaries. For module-level details and maintenance procedures, see the existing [architecture](architecture.md) and [operations](operations.md) references (Chinese).

## What it does

- **Feishu / Lark chat:** persistent connection, direct messages, group mentions, text and basic rich text; organization membership or a selected-member allowlist controls admission.
- **Organization access:** detect the Feishu tenant, admit members without individual pairing, and share authorized MCP connections and read/write directory access with all admitted members. Conversation artifacts use separate workspaces.
- **Group PR review:** read bounded PR patches with a fixed base/head through a service-side GitHub connection and return findings to the authorized conversation. Missing patches and review limits are explicit; no automatic GitHub comments.
- **Directories and sessions:** shared read/write directory access, separate conversation workspaces, and session refresh with bounded historical context.
- **Durable tasks:** SQLite inbox and outbox, message deduplication, input revisions, per-chat and overlapping-directory serialization, and a global concurrency limit.
- **Questions and answers:** the agent can pause for your input; answer by replying to the question or choosing a matching card option.
- **Independent runners:** active tasks run separately from the receiver. Uncertain or interrupted work is retained for review instead of blindly rerunning it.
- **Execution evidence:** file patches, command exit codes, artifact checks and Git HEAD snapshots, with capture limits made explicit.
- **Assistant and scoped memory:** opt-in assistant identity and style, automatic extraction of sourced long-term facts with scope and privacy controls, explicit correction/disable/delete, and bounded handoffs. Memories never grant operation authority.
- **Materials and artifacts:** bounded reading of merged-forward text and direct UTF-8 text files, plus authorized delivery of selected task files. Direct PNG/JPEG images are passed to Codex as bounded, immutable image inputs.
- **Local workbench:** a dashboard, searchable task and session lists, user/status/date filters, pagination, details, profiles, assistant settings, memory review, configuration and connection diagnostics.
- **Concise chat replies:** durable acceptance reactions, original-message/topic routing, safe rich text and a single updatable progress card. Buttons require the Feishu callback subscription.
- **Controlled continuations:** exact-head GitHub check waits (public, or explicitly configured private repositories) can resume the same task without model polling; requested Git pushes execute directly and record the exact task, commit, remote and branch.
- **Remote MCP:** explicitly authorize public HTTPS connections; requested reads and writes execute directly within the external account permissions. OAuth and Bearer authorization are supported.
- **Local service management:** guided setup, isolated official Codex login, diagnostics, immutable service releases and macOS background service commands.

The workbench and CLI support **English and Simplified Chinese**. They follow the system language by default and fall back to English for unsupported languages. Task content, user input and execution logs retain their original language.

PDF/Office/audio material interpretation, autonomous delegation and offline message backfill remain unsupported. Send `/schedule` in a private Feishu chat to manage scheduled reminders and tasks, or view their list in the local workbench. See the [roadmap](development-plan.md) for implemented capabilities and remaining acceptance checks; check the workbench for the running service version.

Organization setup: open **Connections** in the workbench to configure organization access and a GitHub account. Existing installations retain their access rules until an administrator changes them. See [organization access](operations.md#配置与权限).

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

The resumable wizard guides you through Codex detection, isolated login, a required directory whitelist, app credentials and user pairing. A live model/messaging check is optional and may use account quota.

To build a local CLI package:

```sh
pnpm pack
npm install -g ./namo-0.6.1.tgz
namo init
```

Existing configuration can be selected with `--config`. Namo also recognizes `NAMO_CONFIG` and an existing `config.local.json` in the current directory. It does not silently move or overwrite existing configuration or data.

```sh
namo --help
namo ui               # Local workbench; does not start another receiver
namo docs             # Open the local documentation; Ctrl+C stops its server
namo config           # Interactive terminal configuration
namo login --device-auth # Official Codex device login for headless hosts
```

The terminal menu supports arrow keys, field-by-field drafts and Esc to discard an edit. It covers execution, Feishu and organization access, GitHub, MCP, assistant, user profiles and Codex updates. See [headless operation](operations.md#无桌面环境) for Docker, persistent storage and MCP OAuth setup.

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

### Feishu app and service setup

Create and publish an internal Feishu or Lark app with a bot, and set its availability to the intended users. Configure a long connection and subscribe to `im.message.receive_v1`. The documented message scopes are `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly` and `im:message:send_as_bot`; card buttons also require `card.action.trigger`. Follow the setup wizard to pair the user with its one-time code. Organization access can be configured later in the workbench. Do not run another receiver for the same app at the same time.

After initialization, run `pnpm cli start` in the foreground if you did not install the background service. `pnpm cli ui` opens the local workbench without starting a receiver; keep that terminal process open while using it. For a packaged installation, the equivalent commands are `namo start` and `namo ui`.

### Service maintenance

On macOS, `namo service install` installs and starts the background service; `start`, `stop`, `restart`, `upgrade` and `uninstall` manage it. Uninstall retains configuration, data and login. A source build alone does not switch the running service. `namo service upgrade` creates and verifies a release snapshot and backup. Compatible changes can be applied while the receiver remains online; a new execution version is provisional for five minutes and rolls back on receiver restart if it has not been confirmed. Incompatible receiver, storage or dependency changes require a planned stop, an idle check and a verified backup before upgrading. Stopping the receiver does not itself stop independent runners. Inspect tasks, waits, runners and delivery state before a stopped upgrade, and never overwrite newer data with an old backup.

On other platforms use foreground mode; full platform acceptance remains outstanding. See the [operations guide (Chinese)](operations.md#安装升级与回退) for recovery and upgrade procedures.

## Chat commands

Use `/directories` to inspect allowed directories and `/refresh` to refresh with bounded history, `/task` to inspect a task, `/cancel` to stop it, `/new` for a fresh context, `/profile` for your profile, `/status` for service status and versions, `/version` for Namo and Codex CLI versions, and `/help` for available commands. In a private chat, `/model` shows model choices, `/model MODEL_ID` sets your default, and `/model default` follows the service default. The workbench can also set each user's default. Explicit selections are saved with accepted tasks; availability depends on the Codex account.

The workbench’s **Settings → Codex CLI updates** panel provides version checks, manual upgrades, rollback and an automatic update toggle. Automatic upgrades are off by default. While the service runs, enabled updates check the official stable channel daily, defer while busy, and back off for at least an hour after failures. Namo keeps complete private packages in `namo-cli/` under its isolated Codex home, verifies SHA-256, version, app-server handshake, login, permissions and model discovery, then atomically selects the candidate when idle. It preserves the global CLI and model preferences. Rollback disables automatic upgrades. macOS/Linux arm64/x64 are supported. Feishu model discovery refreshes every five minutes and after CLI changes; failed updates retain the selected version. Historical CLI packages are currently retained without automatic cleanup.


See the [conversation guide (Chinese)](getting-started.md#用自然语言与-namo-协作) and [documentation index (Chinese)](README.md) for delivery, memory and approvals.

## Execution boundaries

- Setup requires an explicit directory whitelist. All admitted bot users share read/write access. Conversation files and new instance data use the user-level Namo directory; the launch directory is never the default workspace.
- Configuration, runtime data and isolated Codex login files remain excluded from agent access. Do not grant access to your entire home directory to fix a toolchain issue.
- Skills receive read-only access to individual enabled skill directories and canonical symlink targets. Personal Codex skill opt-outs remain disabled in Namo. Run `pnpm run smoke:skills` to check the actual sandbox boundaries; see [skill access](architecture.md#模块与约束).
- Write permission also permits file deletion. Cancellation, timeout or context reset does not undo completed actions.
- Git push records bind an exact task, owner/chat, explicit repository directory, configured remote, branch, HEAD SHA, configuration revision and expiry, then execute directly without another approval step. This is **limited protection**, not complete enforcement: a generally networked agent or another credential path could bypass the approval entrypoint. Deployment is not implemented as a generic target.
- OpenClaw import requires an explicitly selected source file, supported version and application. It never imports provider authentication, gateways, plugins or tasks, and it cannot automatically take over a receiver; cutover and rollback remain an explicit, verified manual gate.
- GitHub waits default to anonymous public access. In **Connections → GitHub**, configure a local `gh` login or a dedicated token. Admitted members can use the connected account’s actual API permissions in private and group chats, within the user’s request. No repository grant lists or per-call confirmations apply. CI waits never trigger writes. See [GitHub connection settings (Chinese)](operations.md#github-连接).
- A platform send receipt means the platform accepted the message, not that the user read it. Ambiguous sends are retained for review.
- A sleeping or disconnected host cannot provide continuous service. There is no offline history backfill.
- Never commit `config.local.json`, `data/`, logs, tokens or authentication files. Namo does not automatically import personal MCP servers, plugins or third-party model gateways.

The CLI provides `init`, `config`, `login`, `start`, `service`, and `ui`. Status, logs, diagnostics, and Git push records are available in the workbench. Inspect OpenClaw sources under **Connections → Runtime and maintenance**; import with `namo init --import`. Migration never switches receivers automatically. Pushes use configured targets and execute on submission without extra confirmation. See [OpenClaw migration](operations.md#openclaw-导入) and [Git pushes](operations.md#git-推送).

Background service management currently supports macOS. Other systems can use foreground mode but have not completed full platform acceptance. Codex is the only execution backend. Other agents are reserved for future plugins; no additional agent SDKs or probes are included.

## How it works

Namo persists each incoming message before acknowledging it, then schedules a task in a separate runner. Conversations are serialized per chat, overlapping writable directories are mutually exclusive, and a global concurrency limit applies. The official Codex app-server handles the model turn under Namo's filesystem and network policy. Host-managed GitHub and MCP tools use their configured credentials; those credentials are not passed to the model process.

Task state, waits, results and delivery records are stored in SQLite. A runner that is interrupted or lost is not automatically replayed, and an ambiguous delivery is not automatically resent. A model completing, the platform accepting a message and the user receiving it are separate facts. The current database schema is version 16; compatible v13–v15 databases are migrated, while incompatible older databases are rejected rather than deleted.

The local workbench binds to loopback and uses startup authorization, an HttpOnly session, Host and Origin checks, and a content security policy. See [architecture (Chinese)](architecture.md) for module responsibilities, remaining risks and migration details.

## Ego browser access

On macOS, a paired user can use the restricted Ego Lite browser in a private chat when command networking is enabled. The first browser request asks for task-scoped approval; key presses require separate approval. Reply `/mcp-approve MA-ID --always` to authorize the current fixed browser operations for future tasks in that private chat, or `/browser-revoke` to revoke the persistent grant. The browser can use its own network access and logged-in sessions. Group chats and scheduled tasks cannot use this integration.

The tool supports opening pages, snapshots, clicks, filling fields and a limited set of key presses in a task-owned space. It does not accept arbitrary scripts, raw CDP, uploads or downloads. New capabilities are not automatically covered by the persistent grant. A normal run closes its space; interrupted or uncertain operations are not automatically retried and may leave a space to inspect manually. A new run after a human wait does not resume the old browser space. See [Ego browser operations (Chinese)](operations.md#ego-浏览器原型).

## Development

The stack is TypeScript, Node.js built-in SQLite, the official Feishu Node SDK and Codex app-server over stdio. The workbench uses React, Radix Themes and Vite; its compiled assets and fonts are bundled with the CLI.

```sh
pnpm test
pnpm run smoke:codex          # Protocol handshake; no inference
pnpm run smoke:codex -- --run # Explicit real inference test
```

See the [documentation index](README.md), [developer guide](architecture.md#开发与验证), and [remaining work](development-plan.md). The existing implementation and operations references are currently in Chinese.

Project: [github.com/dofy/namo](https://github.com/dofy/namo). Report reproducible issues without credentials, private configuration or raw conversation data.
