# Release notes

## 0.4.0 — 2026-10-30

- Create and manage one-time reminders and daily or weekly tasks in a Feishu
  private chat. The local workbench lists schedules and their states, frequency,
  owners and next trigger times; changes are made through Feishu commands.
- Triggers use the existing durable task and delivery queues, recheck access,
  coalesce missed occurrences and avoid replaying uncertain deliveries.
- Stopped upgrades migrate the existing database from schema 13 to 14 after a
  verified backup. Cross-schema rollback is not supported.

## 0.3.2 — 2026-10-28

- Service and personal model settings share an accessible dropdown with explicit
  inheritance and manual model ID entry. Service settings are labelled as defaults
  for the whole service; personal overrides take priority for new tasks.
- Personal settings show the effective model and its source separately from unsaved
  changes. Unapplied or unavailable service configuration is not reported as active.
  Codex defaults are resolved when a task starts, not inferred from recommendations.

## 0.3.1 — 2026-10-28

- Fix MCP requests on Node 24 by using the same Undici implementation for fetch
  and its DNS-filtering connection agent. Regressions verify the actual rejection
  reason for mixed public/private DNS answers, including native Request inputs.
- Includes all 0.3.0 improvements below.

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
