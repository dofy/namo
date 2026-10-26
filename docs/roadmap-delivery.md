# Roadmap delivery ledger

This ledger records the autonomous R0–R6 implementation pass requested on
2026-10-26. It distinguishes source integration, developer verification,
installed release, and real Feishu acceptance. Those are separate facts.

## Current release boundary

- The schema 8 working-tree candidate has R0–R6 connected to the receiver,
  runner, CLI or authenticated workbench as applicable.
- The installed online receiver is still the older schema 7 release until the
  final review and explicitly authorized upgrade. Building the working tree is
  not deployment.
- Final development suite: **279/279 passed**. Official Codex handshake and real inference passed. A separate real two-turn test adopted updated assistant display settings and explicit memory in the same Codex thread.
- Real restart evidence is saved at `work/roadmap/live-restart/result.json`:
  one running task's runner kept the same PID/run and completed once after the receiver restarted;
  one waiting task survived restart, retained two choices, and resumed the same
  task to completion with two expected runs.

| Area | Source candidate | Evidence and remaining boundary |
| --- | --- | --- |
| R0 messaging and progress | Integrated | Durable reaction, original-message/topic route, safe rich text, one versioned progress card and schema 8 recovery paths. Not yet deployed or accepted on real desktop/mobile clients. |
| R1 assistant identity | Integrated | Optional init setup, authenticated workbench, versioned run adoption and profile-scoped prompt composition. Real multi-user/group behavior remains to be accepted after deployment. |
| R2 OpenClaw import | Integrated | Metadata-only inspect, exact supported source version, explicit app selection, resumable import and pending-review memory candidates. No real migration source has been selected; receiver cutover/rollback is a manual evidence gate. |
| R3 controlled Git push | Integrated with limited protection | Exact task/owner/chat/project/remote/ref/HEAD/config/expiry binding, one attempt and read-only unknown reconciliation. This does not isolate every network or credential path and must not be described as enforced global approval. |
| R4 materials / artifacts | Integrated | Bounded merged-forward/direct UTF-8 text reading, `/deliver`, and `/run --deliver … -- …` pre-authorization. Image input remains unsupported; image files can be delivered without being interpreted. |
| R5 external wait | Integrated | Fixed-HEAD GitHub check observation resumes the original task without model polling. Product default supports public repositories; private token configuration is not wired. |
| R6 explicit memory | Integrated | Authenticated workbench and explicit chat commands cover scoped save/list/correct/disable/delete, pending migration review, run snapshots and bounded handoff. No automatic extraction or background memory writing. |

## Decisions that still require evidence or the owner

- Do not automatically stop or modify OpenClaw. Select a real source file and
  application, review the preview, then verify exclusive receiver state and a
  live round trip before cutover or rollback.
- Do not publish npm or deploy to an unspecified remote environment. The schema
  8 candidate still requires final review and an explicit service upgrade.
- Image material reading remains unsupported until a real multimodal handoff is
  validated. File delivery and image upload are separate from model image reading.
- R3 protects only its approval entrypoint. A broadly networked model runtime,
  credential helper, another command path or external tool may bypass it.
- GitHub private-repository credentials are not read from host tools and are not
  currently configurable by the product; the adapter accepts only explicit
  in-process injection.
- Transport receipts prove platform acceptance, not user delivery or read state.

## Release verification

- Schema 7 → 8 rehearsal on a consistent copy retained all 333 existing rows across 17 tables; integrity was `ok` and foreign-key violations were zero.
- Isolated browser checks covered assistant preview/save, memory save/correct/disable/delete, English/Chinese switching and a 390px layout. Source/version details remain available on demand.
- Packaged CLI English/Chinese help and bundled UI assets passed. Package and source scans found no local configuration, authentication files, business data, or current bot credential. No npm publication occurred.
- Final reviews repaired approval expiry/config/actor/project checks, repository Git command execution, external-wait fairness/deadlines, real Feishu forward hierarchy, progress suppression, default-workspace file delivery, and zero-byte resource budgets.
