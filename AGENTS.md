# Project instructions

- Stack: TypeScript, Node.js 24+, node:sqlite, official Feishu Node SDK, Codex app-server over stdio.
- Validate with `npm test`; protocol handshake with `npm run smoke:codex`. A real inference test requires the bot's official Codex login and `npm run smoke:codex -- --run`.
- Never commit or print `config.local.json`, `data/`, tokens, raw SDK errors, or Codex authentication files.
- Keep inbox acceptance durable before acknowledging Feishu. Do not blindly replay interrupted model turns or ambiguous sends.
- Distinguish transport acceptance from user delivery/read receipts. Preserve per-chat serialization and the global concurrency limit.
- Do not modify an existing OpenClaw service or start another receiver for the same Feishu app without the user's explicit switch instruction.
- Preserve the official Codex provider and isolated auth/config home. No third-party gateways or automatic broad host access.
