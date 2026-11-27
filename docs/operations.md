# Operations guide

Open `namo ui` to check service health, run diagnostics and read logs. The version in the workbench sidebar identifies the running service. A source checkout or a past acceptance test can describe a different version.

<a name="无桌面环境"></a>

## Headless operation

Use `namo config` over SSH or in a container to manage models, execution settings, directories, Feishu messaging, organization access, GitHub, MCP, the assistant, user profiles and CLI updates for Codex and Claude Code. In Docker, run `docker exec -it <container> namo config`. For first-time setup, run `namo init`.

In a supported terminal, the menu updates in place and restores the previous screen on exit. Select a field with the arrow keys and press Enter to edit. Drafts stay in memory while you edit or clear fields. Use **S** at the bottom of a form to save with confirmation, or **Esc** to go back and discard the draft. The menu shows whether the receiver has applied a saved change. You can add, edit, remove, test and import MCP connections from Codex. The workbench theme is a browser preference.

Mount persistent volumes for the configuration, data and isolated Codex login directories. On Linux, run `namo start` in the foreground under the container manager. Open **CLI updates** to see which executables the host can use and their versions. Select an installation to see its available actions. A native Claude Code installation supports checking releases, upgrading and toggling automatic updates. Codex also supports rollback when a previous managed version exists. Keep the terminal open during a manual upgrade and revisit this menu to check the result. The receiver runs automatic updates independently.

For Codex, `namo login --profile codex --device-auth` starts the official device login flow, which has been verified with a real account. For GitHub, run `gh auth login` on the host or configure a dedicated token in the menu. For MCP OAuth, open the authorization URL printed in the terminal. After authorization, copy the final `http://127.0.0.1:.../api/mcp-oauth/callback?...` URL into the terminal’s hidden input, even if the browser cannot connect to the callback. Keep this URL private because it contains a one-time code. The flow expires after ten minutes. The provider must support OAuth discovery and dynamic registration. Verification of terminal OAuth against a live MCP provider is still pending.

<a name="claude-code-与执行器切换"></a>

## Claude Code and executor switching

Install the official Claude Code CLI, version 2.1.330 or later. Enable Claude Code under **Executor connections and sign-in** in `namo config` or **Connections** in the local workbench. To use a Claude account, save the settings and run the displayed `namo login --profile claude` command. The official CLI handles browser login. You can also select `claude` as the first executor in `namo init`.

For a custom gateway that supports the Anthropic Messages API, such as Kaon Router, match the authentication method to your existing Claude Code installation. Choose **Bearer Token** for `ANTHROPIC_AUTH_TOKEN` or **API Key** for `ANTHROPIC_API_KEY`. Enter the existing `ANTHROPIC_BASE_URL`, gateway credential and required model ID. Use HTTPS or loopback HTTP and include any required path prefix in the base URL. After saving, you can run a live reply test. Namo stores the credential in its private configuration and passes it only to the selected Claude Code process.

In the terminal, open **Executors, models and concurrency** to edit an enabled profile’s model, command and timeout or to change the default backend. The default applies to new workstreams without a personal selection. In a Feishu direct chat, use `/agent` to see the current and available executors, `/agent claude` or `/agent codex` to switch, and `/agent default` to restore the service default. Switching back resumes that executor’s most recent workstream. Finish or stop unfinished tasks in the current conversation before switching.

Claude Code supports text, images, file tools in authorized directories and sandboxed Bash. The command network setting applies to both executors. Claude commands connect through a sandbox proxy and require bubblewrap and socat on Linux. A message with a single GitHub PR review link starts a read-only Claude review. The host fetches the patch and source at the pinned commit and holds the GitHub credentials. Codex supports Skills, general Namo MCP tools, model-initiated durable waits and instructions added during a run. Background memory extraction follows the service’s default executor. Both executors share the memory store. Card titles still use Codex. Keep authorized directories separate from Namo’s data and login directories.

For file-based setup, add `"agents": {"defaultProfile":"codex","profiles":{"claude":{"adapter":"claude","enabled":true,"bin":"claude"}}}` at the top level of the configuration. To configure a gateway, add `"gateway":{"baseUrl":"https://gateway.example/anthropic","auth":"bearer","secret":"<gateway-credential>"}` to the Claude profile. For an API key use `"auth":"api-key"`. Set `defaultProfile` to `claude` to use Claude Code for new workstreams.

<a name="配置与权限"></a>

## Configuration and permissions

Namo searches for configuration in order, starting with `--config`, followed by `NAMO_CONFIG`, `config.local.json` in the current directory, then the OS user directory. Set `NAMO_HOME` for an isolated instance. Defaults are `~/Library/Application Support/Namo` on macOS, `~/.config/namo` on Linux (respecting `XDG_CONFIG_HOME`), and `%APPDATA%/Namo` on Windows.

- Edit settings using the setup wizard, terminal menu or workbench. Saving creates a backup and checks for concurrent edits. Current receivers drain the accepted queue before switching. They persist new requests during the drain and create tasks for them after the switch. Cancellations, approvals and answers to waits continue. Existing tasks keep running and revocations are rechecked immediately. If a switch fails, the old configuration and waiting requests are retained. Correcting the configuration allows an automatic retry. Changing the app ID, Feishu region or data directory requires an instance migration. See the [example configuration](../config.example.json).
- Set concurrency to 4–64. The default is 8. Legacy values of 1–3 remain in the file and run with an effective minimum of 4.
- Enter writable directories explicitly during setup. All admitted members share write access to them and can write to the system temporary directory. Ordinary tasks can read other host files outside denied paths, potentially including other applications’ configurations and credentials. Admit only trusted members. Namo protects its own configuration, data, isolated login and explicitly denied paths. New data and conversation workspaces live under the user’s Namo directory.
- Codex uses an isolated login directory. Run `namo login` to reauthenticate using the official provider. Keep personal authentication files and third-party gateways out of this configuration.
- Organization mode verifies tenant identity and app availability. Members use their own conversation directories and share allowlisted directories and authorized MCP connections. Ownership still governs private history and memory.
- After the old queue drains, new tasks use the new configuration. Send `/refresh` to rebuild the native session with bounded history excerpts, or `/new` to start with an empty context. Past tasks and their bindings are retained.

<a name="github-连接"></a>

## GitHub connections

Under **Connections → GitHub**, choose the host’s `gh` login or a dedicated token and save. The change takes effect automatically. In direct and group chats, all admitted members can request operations within that account’s actual read and write permissions. Legacy owner, chat and repository scope fields are read for compatibility. The connection does not add per-call approvals.

If you switch the active account in `gh`, save the connection again to bind the new account. Select public repositories only to disable authenticated access. PR reviews and check waits do not perform writes on their own. Follow-up actions already requested by the user can proceed. If a write has an unknown outcome, reconcile it before issuing another request.

For a PR under review, ask Namo to match a JavaScript or TypeScript syntax pattern in a specific file using ast-grep. Namo searches the full file at the authorized, pinned revision and reports line numbers. A search accepts one file of up to 64 KB and returns the first 30 matches and the total count. Send `/refresh` if an existing Codex session has the old tool parameters.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No incoming messages | Run diagnostics under Connections. Check app publication, events, permissions, availability and whether a second receiver is running. |
| Codex is signed out | Run `namo login` locally, then rerun diagnostics. |
| A task needs more information | Answer the original question or cancel the task. Submitting the same task again can duplicate the work. |
| Lost runner | Inspect the process, its descendants and their effects in the workbench before releasing the reservation. Namo does not automatically rerun it. |
| `delivery_unknown` | Verify receipt in Feishu first. Record the evidence in the workbench and confirm receipt, resend only saved result segments, or dismiss the delivery. |
| `delivery_failed` | Correct the known permission or configuration error, then decide how to handle the saved result. |
| Configuration conflict or stale page | Refresh and review the change again. If authorization expired, rerun `namo ui`. |

Platform acceptance, user receipt and a read receipt establish separate facts. Reconciliation records evidence or acts on the saved result without calling the model again. Cancellation leaves completed actions in place. Logs are read on demand from the end of designated files, up to 80 lines and 64 KiB per file, with known credentials redacted.

<a name="安装升级与回退"></a>

## Installation, upgrades and rollback

`namo service install` installs and starts the macOS background service. The service remains pinned to its registered release snapshot across development builds, starts and restarts. `namo service uninstall` preserves configuration, data and login.

For a receiver that supports live upgrades, build or install the new npm package, then run `namo service upgrade`. Namo creates and verifies a snapshot and online backup, pauses message routing and switches execution code while keeping the Feishu connection open. During the pause it acknowledges messages only after committing them to SQLite. Routing resumes with the existing queue and concurrency limits. In-flight independent runners continue their existing runs. Messages with unknown delivery outcomes are kept for reconciliation.

`active-runtime.json` records the execution release separately from the registered receiver snapshot. A new runtime runs on trial for five minutes and is confirmed only if the receiver stays healthy. If the receiver exits before confirmation, the next start selects the previous runtime without replaying the upgrade. The online backup captures a consistent read snapshot. Preserve messages received afterward in the current database. If the CLI times out waiting for an upgrade, check the version in the workbench before stopping the service or issuing another request.

Codex CLI release metadata, packages and SHA-256 digests all come from `releases.openai.com`. Verification relies on that site and TLS without an independent signature. Namo retains a verified candidate while the queue is busy and reuses it when idle. Repeated identical automatic failures use exponential backoff and stop after five consecutive attempts. Inspect the failure before re-enabling automatic updates or retrying manually.

Open **Settings → Maintenance** to see the versions of the configured Codex and Claude Code CLIs on the host. For a default native Claude installation, **Check for updates** reads the latest release from Anthropic. Confirming an upgrade runs `claude update` using the host’s release channel, then rereads the installed version. For package-manager or custom launcher installations, update through the original installation method.

If an existing native Claude configuration points directly to a numbered executable under `~/.local/share/claude/versions/`, set its executable to `claude` or the absolute path of the `~/.local/bin/claude` launcher. The launcher follows native upgrades.

**Automatically upgrade Claude Code CLI** is off by default for the native installation. The receiver uses one timer for Codex and Claude Code. It ticks once a minute and normally checks the official release sources every 24 hours. Claude Code upgrades only when both the stable and latest versions are newer than the installed version and the task queue is idle. New messages continue to queue during the upgrade. Tasks resume afterward. This updates the host’s shared Claude installation.

A live upgrade requires compatible receiver code, database schema, storage implementation and runtime dependencies. Changes to modules that read or write shared task, approval, memory or scheduling state also require a restart. If the receiver predates live upgrades or an incompatible component changed, the command leaves the service running. Schedule a receiver switch explicitly. Messages that Feishu has not delivered during a disconnection may be unrecoverable. Finish or cancel outstanding tasks and reconcile lost runs, waits and pending deliveries first. **Independent runners can keep running after the receiver stops.**

The workbench counts live upgrades loaded by the current receiver process. After five, it recommends restarting during a safe window to release modules that cannot be unloaded. Restarting resets the counter and preserves release snapshots and backups.

```sh
namo service stop
# In the workbench, verify that the service has stopped and all tasks, waits, runners and deliveries are accounted for.
namo service upgrade
namo service start
```

An offline upgrade or reinstall over existing data requires an idle system and a verifiable backup before switching the registration. Failure preserves the old registration and leaves the service stopped. Offline upgrades can migrate schemas 13, 14 and 15 to 16 in a transaction. Older development databases require a rebuild. After starting the new service, verify the connection, running version, historical data and actual message receipt.

Each install, offline upgrade and live upgrade creates a verified backup in `data/backups/`. After a successful new backup, Namo keeps the five newest verified backups and removes interrupted `.pending` directories older than seven days. It leaves directories with unrecognized names alone. A cleanup error does not invalidate the backup just created.

**Rebuilding a legacy test database (v0–12, v13 baseline).** Stop the receiver and verify that no workers are running. Back up the data directory, then move `bot.sqlite` and any `bot.sqlite-wal` and `bot.sqlite-shm` files together to the backup location. Keep the configuration and `codex-home`. Install or start the new version to create an empty database and verify the first task and the workbench. Historical tasks, memories and receipts stay in the old database. Namo leaves deletion to the operator.

Namo uses SQLite’s backup mechanism and verifies the contents. A complete offline backup also includes the configuration, entire data directory and isolated login directory. Copying only the main file of a live database omits the WAL. For rollback, select a compatible snapshot and preserve newer data. Reverse schema migration is unsupported. The launcher rejects missing, altered or incorrectly registered snapshots.

<a name="git-推送"></a>

## Git pushes

Configure the absolute `gitBin` and allowed remotes in `gitApprovals` on the host. The following example allows an SSH push to `origin`. Merge it into your existing configuration.

```json
{"gitApprovals":{"gitBin":"/usr/bin/git","remotes":[{"name":"origin","url":"git@github.com:owner/repo.git","transport":"ssh"}]}}
```

In **Settings → Maintenance → Runtime and maintenance → Git pushes and history**, select a successful task, the absolute path of an allowlisted repository and the target branch. Submitting executes the push. In chat, use `/push N-<task-id> origin refs/heads/main --directory /path/to/repo`. The alias `/push-request` is still supported. Check results with `/push-status AP-<id>`. For an unknown outcome, the remote reconciliation action performs a read-only check. Preview requests queued before an upgrade retain their original intent and do not push automatically.

A push requires a clean worktree, an exact commit and a preconfigured target branch. The push entry point rejects force pushes, tags, branch deletion, deployments, custom hooks and Git LFS filters. These checks apply only to this entry point. Other network-enabled tools have their own controls.

<a name="openclaw-导入"></a>

## OpenClaw import

The workbench can inspect a source read-only. To import, run `namo init --import`. Select the instance and app explicitly. The importer accepts a regular `openclaw.json` file in standard JSON for version `2026.10.6`. Handle other versions, JSON5 and SecretRef manually. The importer does not infer fields or resolve credentials through the source system.

Review conflicts, allowlists, workspaces and candidate materials. Import narrows permissions by default and excludes model credentials, gateways, plugins, tasks and sessions. Candidate memories are staged for review and require activation.

Import saves configuration and prints instructions for a manual switch. It leaves the OpenClaw service running as configured. There is no complete management UI for takeover or rollback. Identify the target app, resolve in-flight work, disable the old receiver manually and verify that both receivers are inactive before starting Namo. For webhook setups, disable the old callback and switch to a long connection. Verify actual send, receive and user confirmation with the same app. For rollback, stop Namo before restoring the previous receiver and preserve data created in the interim. Run only one receiver at a time.

## MCP connections

Under **Connections → MCP connections**, add a public HTTPS Streamable HTTP MCP server. Open the add or edit dialog, enter its connection ID and address, then select **Save and authorize** for OAuth or enter a dedicated Bearer token and save. The connection becomes available after authorization. OAuth discovers the authorization server from its metadata and uses PKCE and a one-time callback. Probe the advertised optional scopes and select those you need. If the provider publishes no list, use its defaults or enter documented scopes under advanced settings. A failed probe preserves the selection and displays an error.

When changing the address or scopes, keep the old authorization in place. The workbench holds the draft in memory and replaces the configuration and credentials together only after successful authorization. Cancellation, failure or a configuration conflict preserves the existing connection. Closing the dialog cancels unfinished authorization. Namo stores tokens in its private local data directory and refreshes them when needed, independently of Codex credentials. This version requires dynamic client registration and standard authorization server discovery. The authorization, registration and token endpoints must share one HTTPS origin.

You can also import selected remote connections from the Codex user configuration. Import copies the names and query-free addresses. Authorize each new connection before use. Credentials, environment variables, local commands and connections internal to plugins are excluded. Remote connections reject URL query parameters, local or private network addresses and custom headers. Network access checks DNS results and rejects redirects. Legacy Linear settings load as a regular remote connection, retaining the original read-only address, scopes and usable credentials. Reauthorize if refresh fails.

To add a local MCP server in the workbench, specify the absolute executable path and its arguments as a JSON array of strings. The MCP section of `namo config` also supports adding, editing and testing local connections. Add only trusted executables. Namo launches the process with its OS user’s permissions, and all admitted chat members can call its tools. Personal Codex environment variables and credentials are excluded from import. For Inkflit, use `/Applications/Inkflit.app/Contents/MacOS/Inkflit` with `["--mcp"]`. Run Namo and Inkflit under the same user on the same Mac.

All admitted chat members can use authorized MCP connections. Reads and writes execute within the external account’s permissions. There is no per-call confirmation or ten-minute approval expiry for these calls. Before each remote send, Namo checks user access, connection credentials, task cancellation and the tool definition. An unknown outcome is recorded durably. The same task does not automatically resend the operation. Task deadlines and network timeouts still apply. Historical approvals remain available for reconciliation without replaying completed tasks. MCP has no separate member, group, project or per-task enablement scope. Bot admission determines who can request work, and the external account determines what resources the server can access.

MCP changes take effect with other service settings after the old queue drains. The old queue keeps its original configuration, and Namo rechecks revocations at tool use and result delivery. Older receivers require manual application. If an existing workstream lacks the MCP tools, send `/refresh` in Feishu. The workstream and task records remain, and the next task starts a new model session with bounded recent excerpts. Use `/new` for a new workstream. Previously read context cannot be removed automatically after revocation. Configuring MCP connections disables native Codex plugins and apps. If the isolated Codex configuration still enables unmanaged MCP services, disable them before starting a task. The existing GitHub connection and review flow remain available.

## Scheduled tasks and waits

Scheduled tasks use separate workstreams. Staged materials stay in the direct chat. Each trigger uses the selected agent’s model setting at that time and executes GitHub operations within the original user request and current permissions. A human wait expires after 24 hours and the task record is retained. Waits that predate this expiry mechanism have at least 24 hours from activation. Previously completed actions stay in effect.

A wait can contain 2–4 independent multiple-choice questions. Namo saves the first answer to each and resumes only after all answers arrive. Buttons expire after 15 minutes. After expiry, quote the message or use `/resume WAIT-ID ...` to answer all questions together. Use `/task` to see which questions have answers. Answers supply information and do not grant permission to act. Existing Codex sessions may need `/refresh` to register the multi-question tool parameters. Cards show each selected answer. If a card update has an unknown outcome, use `/task` to check the state. Namo avoids blind retries and deduplicates repeated clicks.

<a name="ego-浏览器原型"></a>

## Ego browser prototype

On macOS, install and initialize Ego Lite. When a paired user requests browser work in a direct chat, Namo asks for a task-scoped browser grant on first use. With cards and callbacks configured, use the allow-once, always-allow or deny button. Text replies are also supported. For example, `/mcp-approve MA-<id> --confirm` grants open, snapshot, click and fill operations for the task. Key presses require separate approval. `/mcp-approve MA-<id> --always` grants that user the current set of open, snapshot, click, fill and key-press operations for future tasks in the same direct chat. This includes operating signed-in sites with the browser’s own network access and login state. Send `/browser-revoke` to restore confirmation for subsequent calls. Operations already issued remain in effect. The grant is bound to the Feishu app, user and direct chat. It excludes other users, group chats and schedules. Disabling command network access also disables this capability.

The prototype excludes arbitrary scripts, CDP, uploads, downloads and selecting an existing space. A persistent grant covers only the operations and keys listed when it was issued. New capabilities require a bounded implementation and a new user confirmation. Each browser space belongs to one worker run and closes on normal completion. After a stop, user takeover or uncertain outcome, inspect and close any remaining space in Ego manually. Namo avoids automatic retries or takeovers. A new run after a human wait cannot resume the old space. Restarting the receiver leaves surviving workers running. A lost worker is not replayed.

## Forwarded messages, models and usage

In a group that requires an @mention, a merged forward sent alone is staged as the sender’s material. It does not start a task. The same sender can then mention the bot and use `/run`. Delivery of unmentioned group messages depends on the Feishu app’s permissions. Images and files inside a merged forward may be unreadable.

Under **Settings → Work and execution**, select the default agent and edit each agent’s model, command path and timeout. Each agent has one model setting. Namo writes the Codex selection to `config.toml` in that agent’s isolated directory and the Claude Code selection to `settings.json` in its isolated configuration directory. The terminal menu edits the same settings.

Send `/model` in a Feishu direct chat to see the current agent, the model for new tasks and the most recently recorded task model. A locally paired member can use `/model <model-id>` to change the current agent’s shared model or `/model default` to restore the runtime default. The default agent applies to new workstreams. Switch an existing workstream with `/agent`. Task details and result cards show each task’s model.

On the receiver’s first start after an upgrade, Namo migrates existing agent model settings into isolated configurations that have no model set. An explicitly selected model is pinned when a task is accepted. A task following the runtime default resolves its model on first execution.

`codex.dailyTurnLimit` caps daily model turns in UTC, including foreground tasks, background memory extraction and card title summaries. Set it to `0` for no limit. The default is 100 in organization mode and unlimited otherwise. At the limit, tasks stay queued, the user is notified, and work resumes on the next UTC day. Memory extraction waits and titles use text excerpts. This counts turns. For actual charges, consult the service handling the request.

Task cards initially show short excerpts of the task and result. If the service account’s model catalog lists a supported small model and a concurrency slot is free, Namo can generate titles asynchronously. If the model is unavailable, times out, exceeds quota or yields its slot to foreground work, the excerpt stays in place. Task execution and replies continue. A catalog listing alone does not establish inference access. Namo makes at most one attempt each for the start and completion titles.

## Inbox retention

By default Namo retains the original inbox text. To limit future retention, explicitly apply `retention: {"enabled": true, "inboxDays": 30, "acknowledgeRedaction": true}` in local settings. Redaction covers message bodies and material descriptions only for safely completed messages received after the policy was enabled and older than the configured period. Deduplication and routing metadata remain. Messages received before activation or while the service observed the policy disabled retain their original contents. Set `enabled: false` to stop cleanup. Results, attachments, memories, logs and backups have separate retention. Back up the data and confirm the intended scope before enabling this policy.

## Editing in the workbench

Connections shows a summary and status for each connection. Edit MCP, GitHub and bot access in their respective dialogs. Actions are at the bottom of each dialog. Clicking the backdrop preserves unsaved edits. New MCP connections and permission changes support **Save and authorize**. Anonymous and Bearer-token connections can be saved directly. After authorization failure, return to the draft, edit and retry. Cancelling discards the unfinished authorization draft. Assistant settings, global settings and profiles have separate pages with a fixed save area at the bottom.

A paired owner can request directory access in a Feishu direct chat. Namo shows the resolved absolute directory and the shared read/write scope. The owner can approve or deny by reply or button. Approval uses the same configuration validation and safe reload after the old queue drains. If the configuration changes, access is revoked or the directory changes, the grant is not applied. Once effective, only the unfinished work listed in the request continues. Interrupted tasks are not replayed automatically. Organization members cannot grant themselves broader shared directory access.
