---
name: namo-remote-workbench
description: Configure, verify, or disable the optional HTTPS Namo workbench with its own sign-in and sign-out. Use for remote management of an existing Namo installation, including access through a private proxy or Cloudflare Tunnel.
---

# Namo remote workbench

Run `namo ui --remote-guide` to read these instructions from an installed npm package. Use this guide for a single-owner installation with an existing Namo configuration.

## Configure

1. Verify the target host, the installed `namo --version`, and which Namo configuration the owner wants to manage. Get the intended dedicated HTTPS hostname and access boundary from the owner before creating a route. Use a private or identity-gated HTTPS proxy for this administrative interface. The proxy must run on the same host as Namo, preserve the full public `Host` (including a non-default port), and pass the browser's `Origin` through unchanged. Bypass caching for this hostname.
2. Generate a dedicated password on the Namo host. The password file must be a regular file owned by the Namo OS user, with no group or other permissions. The file contains 32–256 printable ASCII characters without spaces, with an optional final newline. Keep the password out of prompts, command arguments, logs, and version control. Have the owner transfer it to their password manager through an approved private channel. The following example exclusively creates the file:

   ```sh
   (
     umask 077
     set -C
     openssl rand -hex 32 > "$HOME/.namo-workbench-password"
   )
   ```

3. Run a separate process as the same OS user that owns the Namo installation. Use `--config /absolute/path/to/config.json` if the receiver uses an explicit config. Stopping this foreground process stops the remote workbench. To keep it running, supervise this exact command with the host's process manager and use absolute paths in its service definition.

   ```sh
   namo ui --remote https://namo.example.com \
     --port 18789 --password-file "$HOME/.namo-workbench-password"
   ```

4. Route `https://namo.example.com` to `http://127.0.0.1:18789` over the same host's proxy. Namo binds to that loopback port; keep the browser connection on HTTPS and redirect or reject public HTTP at the proxy. Use a dedicated hostname at the root path. For Cloudflare Tunnel, add a published application for that hostname with the HTTP service above and set **HTTP Host Header** to `namo.example.com` explicitly. Limit the route to the owner with Cloudflare Access before publishing it. Use the existing Access and tunnel configuration for the chosen host. [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/) · [Origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)

Regular `namo ui` continues to use a separate ephemeral listener and a one-time local browser authorization. The optional remote listener starts no Feishu receiver and grants the signed-in owner normal workbench privileges. New MCP OAuth authorization and the native folder picker belong in the local workbench; the remote workbench can use existing connections and its browser-based directory picker.

## Verify

- Confirm the listener is on `127.0.0.1`. This origin-side check sends no credentials and should return a redirect to `/login?next=%2Fsettings`:

  ```sh
  curl -sS -D - -o /dev/null -H 'Host: namo.example.com' http://127.0.0.1:18789/settings
  ```

- In an isolated browser, open the HTTPS hostname, sign in with the owner password, and check that opening a protected page after signing in returns to that page. Check **Sign out** at the bottom of the desktop sidebar and in the mobile menu. Each exit returns to `/login`. A guest navigation to `/api/state` should return `401` after the edge has admitted the browser.
- Check proxy Host and HTTPS origin first on a `403`. The browser's scheme, hostname and port must exactly match `--remote`; forwarding headers cannot correct a mismatch. Check the loopback port and foreground process on a proxy `502`.
- After upgrading the package, restart the remote workbench process so it loads the new version. Repeat the isolated browser checks. Sessions expire after 12 hours, on logout, or when the remote process stops.

## Turn it off or rotate the password

Stop the remote workbench process and remove its proxy route. To rotate the password, replace the private file securely and restart that process. The original local command is always available as `namo ui`.
