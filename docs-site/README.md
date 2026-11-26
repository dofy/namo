# Namo documentation site

<a name="english"></a>

## Run locally

With the Namo CLI installed, run `namo docs`. This starts a local server and opens the documentation in your browser. Press Ctrl+C to stop the server.

From a source checkout, run these commands in the repository root.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm cli docs
```

## Edit the site

Run `pnpm docs:dev` from the repository root to preview edits. Update the English and Simplified Chinese text together in [content.js](content.js). Keep section IDs stable so language switching and existing links continue to work.

For static hosting, deploy the contents of `docs-site/`. See the [documentation index](../docs/) for the architecture and operations guides.
