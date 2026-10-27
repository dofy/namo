# Organization access and group PR review — 2026-10-27

## Scope

Namo is a self-hosted service for a Feishu organization. This release separates tenant admission, host project grants and GitHub repository audiences. Existing paired mode remains compatible and upgrades do not automatically broaden access.

The authorized local deployment enables one verified organization and one selected group/repository grant. Existing owner access to configured projects is retained. New members use isolated read-only workspaces; private user grants never imply permission to publish in a group. Private identifiers and repository contents stay outside this document.

## Implementation and verification

- Bilingual UI/CLI support organization selection and resource audiences. Tokens and local gh credentials stay on the host; repository reads use bounded GitHub REST requests.
- Group PR review reads fixed base/head metadata and at most 200 file patches, with explicit missing/truncated coverage. It does not clone, post reviews, push, merge or deploy.
- Permission checks cover initial reads, resumed delivery, progress updates and file delivery. Configuration changes stop active organization runs; new permissions create a new policy context. Public progress, automatic memory and the agent registry from concurrent releases are retained.
- The combined full suite passed 451 tests. A subsequent agent-policy test and registered-Node runner/GitHub/organization checks passed (26 targeted checks). Official Codex authentication and permission handshake passed; this handshake alone does not prove inference.
- Isolated Chrome checks passed for English and Chinese/mobile UI, organization save, selected repository/group grants, multiline identities, no horizontal overflow and no page errors.
- Authorized host-side preflight read the private PR's 14 changed files. This is API evidence, separate from group delivery.

## Deployment

- Source commit: `753c1ac22a40cfd6f4f0819fc65fed5e4cfac80b`.
- Previous release: `414e6f13130465ba93607b678daf75924ed9cf39d674612a2a099eecfcb38d6b`.
- Installed/running release: `3848325f3a103d3bbbe4a5d2b86de35d0b4987878c5c80788b32694c235532e8`.
- One existing receiver replaced after its queue was idle; the old process was confirmed stopped. New service is ready and Feishu-connected; runtime manifest verified.
- Schema remains 10. All 915 existing rows across 23 tables were retained. SQLite integrity is `ok`, with zero foreign-key violations.
- Protected backup taken before applying the authorized admission/resource configuration changes. Other configuration, Codex authentication and registered Node executable preserved.

## Live acceptance

Pending: the user has been asked to mention Namo in the selected group with the authorized private PR. Verify durable group receipt, official Codex `read_pull_request`, final reply in the same group and user confirmation. Automated two-user isolation is covered; real multi-member/external-tenant and live revocation scenarios remain separate follow-ups.

OpenClaw switch, actual Git push feature acceptance, npm publication and Claude/Cursor execution remain outside this release.
