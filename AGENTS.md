# Project instructions

- Package manager: pnpm 12.15.0, pinned via packageManager. Use pnpm-lock.yaml only; install with `pnpm install --frozen-lockfile`.
- Stack: TypeScript, Node.js 24+, node:sqlite, official Feishu Node SDK, Codex app-server over stdio.
- Local UI: React, Radix Themes, Vite; browser code stays in `ui/` and imports only browser-safe contracts from the server. Ship compiled assets in the CLI package, retaining loopback authentication and CSP.
- Validate with `pnpm test`; protocol handshake with `pnpm run smoke:codex`. A real inference test requires the bot's official Codex login and `pnpm run smoke:codex -- --run`.
- Never commit or print `config.local.json`, `data/`, tokens, raw SDK errors, or Codex authentication files.
- Keep inbox acceptance durable before acknowledging Feishu. Do not blindly replay interrupted model turns or ambiguous sends.
- Distinguish transport acceptance from user delivery/read receipts. Preserve per-chat serialization and the global concurrency limit.
- Do not modify an existing OpenClaw service or start another receiver for the same Feishu app without the user's explicit switch instruction.
- Preserve the official Codex provider and isolated auth/config home. No third-party gateways or automatic broad host access.
