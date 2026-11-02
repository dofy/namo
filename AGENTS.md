# Namo — agent instructions

Single private package (`namo`), ESM, Node `>=24.15` (`bin/namo.js` hard-exits below that). `pnpm-workspace.yaml` exists but only sets `saveExact` and build/release-age policy — this is **not** a monorepo.

## Commands

```sh
pnpm install --frozen-lockfile   # pnpm 12.15.0 pinned; pnpm-lock.yaml is the only lockfile
pnpm run build                   # build:server then build:ui
pnpm test                        # build + node scripts/test.mjs
node scripts/check-package.mjs   # packaging check; NOT a package.json script
pnpm cli ui                      # = node bin/namo.js ui; requires dist/ to exist
```

- `build:server` runs `scripts/clean-server-build.mjs` first to delete `dist/{src,test,scripts}` — tsc leaves stale output for renamed/deleted sources. Never skip it.
- `build:ui` = `typecheck:ui` + `vite build`. `ui:watch` only rebuilds assets; the server keeps serving `dist/ui`.
- No linter or formatter. `tsc --strict` with `noUnusedLocals`/`noUnusedParameters` is the whole gate.

## Tests

Tests are **compiled, not run from source**. `scripts/test.mjs` lists `test/*.test.ts`, maps them to `dist/test/*.js`, and runs `node --test --test-concurrency=4`. Extra argv is forwarded before the file list.

```sh
node scripts/test.mjs --test-name-pattern='wait'       # after a build
pnpm run build:server && node --test dist/test/engine.test.js   # single file
```

Tests are archived by feature with shared fixtures in `test/helpers.ts`. Add boundary cases to the existing suite; do not create per-change test files. Numeric budgets, state enums and field shapes live in the contract tests, not in docs.

## Smoke

- `pnpm run smoke:codex` — protocol/account/permission handshake only, no inference.
- `pnpm run smoke:codex -- --run` — real inference; consumes the bot's Codex account quota. Needs the bot's official Codex login. Ask before running.
- `pnpm run smoke:skills` — sandbox skill read/write boundaries; only needs `build:server`, never calls the model.

## Build quirks

- Two TS projects: `tsconfig.json` (server, `rootDir: "."`, includes `src`/`test`/`scripts`, emits to `dist/`) and `tsconfig.ui.json` (`noEmit`, includes only `ui/**` + `src/ui-contract.ts`).
- Browser code lives in `ui/` and may import exactly one server file: `src/ui-contract.ts`. Anything else breaks the UI typecheck.
- Vite root is `ui/`, output `dist/ui`, `publicDir: false`, env prefix `NAMO_UI_PUBLIC_`.
- The workbench changelog is **generated at UI build time** from Git by `scripts/changelog.ts` into `__NAMO_CHANGELOG__`: bounded by `package.json` version changes on main, only merged `feat`/`fix`/`perf`/`style` commits, committed content only. Bump `package.json` and rebuild — do not hand-edit sources or the Git index. Shallow clones fall back to stored history, which is why CI uses `fetch-depth: 0`.
- `check-package.mjs` runs `pnpm pack` and asserts an exact **allowlist** of packaged paths. New runtime files or asset extensions require updating both its regexes and `files` in `package.json`.
- CI (`.github/workflows/ci.yml`): ubuntu + macOS, Node 24, frozen install, `pnpm test`, then `check-package.mjs`. Real Codex/Feishu acceptance stays local, never in CI.

## Never commit or print

`config.local.json` (and any `*.local.json`), `data/`, `work/`, tokens, raw SDK errors, Codex auth files, or raw conversation data. Local config/data are mode `0600`/`0700`. `output/` is only partially ignored — check `.gitignore` before adding anything there.

## Behavioral invariants

- Persist inbound messages before acknowledging Feishu. Keep per-chat serialization, the global concurrency limit, and mutual exclusion over overlapping real directories.
- Model completion, platform acceptance and user receipt are three distinct facts; never infer one from another. Do not replay interrupted model turns or resend on unknown delivery results.
- Official Codex provider with an isolated auth/config home. No third-party gateways, no extra agent SDKs or probes, no automatic broad host access.
- Schema version 15 — tables in `src/schema.ts`, init/migration in `src/schema-migrations.ts`. v13 is the baseline; v0–12 compat is gone. Incompatible databases are rejected, never auto-deleted. UI queries must not trigger migrations.
- Do not modify an existing OpenClaw service or start a second receiver for the same Feishu app without an explicit switch instruction from the user. Builds never switch a running service.
- UI binds loopback only, with one-time startup authorization, HttpOnly session, Host/Origin checks and CSP. Keep all of it.
- Background service management is macOS-only; other platforms are foreground-only and unaccepted.
- i18n: stable English message IDs; `src/locales/en.ts` and `zh-CN.ts` must keep identical placeholders. Icons come from Lucide only.

## Docs

`docs/architecture.md` (Chinese) is the authority for module entrypoints and the behavior each must preserve; `docs/operations.md` covers maintenance and recovery. When prose and scripts/config disagree, the executable wins.
