# Getting started

Namo connects Feishu and Lark chats to a local executor. This guide follows setup with the official Codex CLI. Background service management is supported on macOS. Full acceptance testing on other platforms is still pending.

## Install and set up

You need Node.js 24.15 or later, the official Codex CLI and a custom enterprise app in Feishu.

```sh
npm install -g @dofy/namo
namo init
```

For a source build, use pnpm 12.15.0. See [development and verification](architecture.md#development-and-verification).

The interactive wizard guides you through writable directories, app credentials, an isolated Codex login, the Feishu connection and user pairing. You can optionally test a live exchange and install the background service. Secret entry is hidden. Setup can resume after cancellation and preserves existing configuration and users. Run only one receiver for the same app.

| Feishu setting | Required configuration |
| --- | --- |
| App | Create a custom enterprise app, enable the bot, set its availability and publish it. |
| Event delivery | Select a persistent connection. Keep the setup terminal connected while saving this setting. |
| Message event | Subscribe to `im.message.receive_v1`. |
| Message permissions | Grant `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly` and `im:message:send_as_bot`. |
| Interactive cards | Also subscribe to `card.action.trigger` and publish the change. |

Send the wizard’s one-time pairing code in a direct chat with the bot, then confirm the identity in the terminal. You can configure organization access in the workbench after initialization. Admitted organization members do not need individual pairing.

## Common CLI commands

| Command | Purpose |
| --- | --- |
| `namo init` | Initialize and pair. Use `namo init --import` to import an OpenClaw configuration. |
| `namo config` | Configure executor connections, models and CLI updates from a terminal. |
| `namo login --profile <id>` | Sign in to the selected Codex or Claude Code account in its isolated environment. |
| `namo start` | Run the receiver in the foreground. |
| `namo service <action>` | Manage the service with `install`, `start`, `stop`, `restart`, `upgrade` or `uninstall`. |
| `namo ui` | Open the local workbench independently of the Feishu receiver. |

Select a configuration with `--config /absolute/path/config.json`. Set the language with `--lang system|en|zh-CN` or `NAMO_LANG`. Run `namo --help` for the full command list. For maintenance procedures, see the [operations guide](operations.md).

## Workbench

`namo ui` opens your browser. Keep the terminal process running and press Ctrl+C to stop it. Local page authorization expires after two hours. Use the sidebar to switch between English and Simplified Chinese. Task text and logs retain their original language.

| Page | Common actions |
| --- | --- |
| Overview, Tasks, Sessions | View statistics, search and filter tasks, inspect evidence, stop work and reconcile exceptions. |
| Schedules | Inspect reminder and task status, frequency and next run. Manage schedules in a direct chat. |
| Assistant | Set the assistant’s identity and response style and choose whether to use your profile. |
| Memory and profiles | Inspect, correct, deactivate or delete memories. Edit forms of address, language and time zone. |
| Settings | Configure writable directories, models, concurrency and time limits. Saved changes apply automatically after the old queue drains. |
| Settings → Connections | Manage organization access and the GitHub account and run connection diagnostics. |
| Settings → Maintenance | Read service logs, review Git pushes and inspect OpenClaw sources. |
| Changelog | View release changes. The build generates new entries from commit history. |

Already accepted tasks use their original configuration. New tasks use the saved configuration after the accepted queue drains. Connection diagnostics run without model inference. A live reply test for the selected executor requires confirmation and may consume account quota.

<a name="用自然语言与-namo-协作"></a>

## Working with Namo in chat

Tell Namo what you want to do. In groups, mention the bot by default. For example, ask it to list your tasks, stop the current task, send a completed report, switch back to a project conversation or check a repository every day at 9 a.m. and report changes. When it needs a target, path or time, Namo asks or looks it up. It reports success after the service confirms the operation.

You can stage text for later and then explain how to use it. Answer a waiting task by quoting its question or selecting an option. Manage profiles, model preferences, memory and schedules in direct chats. Existing slash commands remain available.

Create schedules in a direct chat and specify the time and time zone. Daily and weekly schedules repeat at fixed intervals. When the service restarts, it combines multiple missed occurrences into one. Pausing or deleting a schedule leaves already queued or running tasks in place.

Configure each agent’s model under **Settings → Work and execution**. In a Feishu direct chat, use `/model` to inspect the current agent’s selection or `/model <model-id>` to change its shared model. Explicit selections are pinned at task acceptance. Runtime defaults resolve before the first run. If the model is unavailable, the task reports failure.

Cancellation leaves earlier file changes and external operations in place. If a send has an unknown outcome, verify receipt before requesting another send.

## Materials and memory

Namo accepts text from merged forwards, directly uploaded UTF-8 text or Markdown, and PNG or JPEG images. Images can accompany new tasks, queued additions and replies to waits. Adding attachments during execution, reading attachments nested in merged forwards, and parsing PDF, Office, audio or video inputs are unsupported.

With explicit authorization, Namo can deliver task files in text, Markdown, PDF, PNG, JPEG, GIF or WebP format. Delivery and input parsing have separate format support. Specify an exact path relative to the task workspace. Namo rejects symlinks, sensitive files and paths outside the workspace.

Images generated by the official built-in image tool are sent to the original chat after the task completes or enters a wait. Each image is verified, frozen and queued for durable delivery. Feishu acceptance and actual user receipt are tracked separately. An image exceeding the Feishu image limit is sent as a file. Unknown deliveries are not automatically retried. For other artifacts, ask for the file and identify it or its source task.

To receive a previous image again, ask in the same conversation or quote the specific image message. Namo looks up existing delivery records for the current user and workstream and rechecks access and file contents. If it cannot verify a safe resend, it tells you. A local path alone does not establish delivery.

By default, automatic memory extraction keeps source-backed long-term facts from direct user conversations. It uses a separate call to the service’s default executor and may consume quota. Temporary instructions stay in task context. Imported memories need review before activation. Enable profile use explicitly in Assistant settings. Private content remains restricted in group chats.

The Assistant page separates identity and responsibilities from response style. “Answer first, then explain” controls the order of the response. For example, the assistant might give a merge recommendation before listing its reasons. Execution, permissions and approvals keep their usual behavior. Response length controls detail, technical depth controls explanation, and explicit instructions for a task take precedence.

Until you save custom settings, the page shows the proposed defaults. Select **Save and enable** to apply them. Internal settings version 0 identifies an unsaved profile. Existing users retain their previous response style until they opt in. Format previews are examples generated without model inference.

Corrections, deactivation and deletion affect future retrieval. Existing native sessions, past messages and backups retain their copies. Use `/new` for a clean context.
