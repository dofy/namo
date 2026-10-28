# Release notes

## 0.3.0 — 2026-10-28

- Code review reads paginated patches and surrounding source at fixed revisions.
  Reports separate reading coverage from reviewed evidence and explain validation limits.
- Feishu task replies use readable Markdown and compact completion statistics.
  Session lists show the first request, latest task, recent activity, current session,
  and a copyable command to continue the right conversation.
- All workbench pages share consistent headings, panels, explanations, and actions.
  Mobile option cards place their icon, title, and switch on one compact row.
- Assistant preferences explain their effect and activation state in plain language.
  Unsaved drafts, conflict checks, and confirmation dialogs are preserved.
- Compatible runtime upgrades retain the receiver and durably queue incoming messages
  while replacing execution code. Releases are verified and backed up before activation.
  The first upgrade from a receiver without this capability requires a controlled restart.
  Receiver, dependency, and database changes can also require a restart; they are not
  silently treated as hot upgrades.
- Includes the previously local model selection, Codex CLI update controls, version
  reporting, generated changelog, and scoped MCP connection and authorization improvements.

This version does not change the database schema. Local configuration, authentication,
and conversation history are preserved. It does not claim that Feishu will replay
messages sent during an offline receiver interval.
