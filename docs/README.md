# Namo documentation

[English technical guide](technical-guide.md) · [Technical guide in Simplified Chinese](technical-guide-zh-cn.md) · [Product overview](../README.md)

Browse the [documentation site](../docs-site/) by topic in English or Simplified Chinese. From a built checkout, run `pnpm cli docs` in the repository root. With the CLI installed, run `namo docs`. The command starts a local server and opens the site in your browser. Press Ctrl+C to stop it. The site provides section navigation and light and dark themes.

| Guide | What it covers |
| --- | --- |
| [Technical guide](technical-guide.md) | Installation, features, permissions, operation and development. Also available in [Simplified Chinese](technical-guide-zh-cn.md). |
| [Getting started](getting-started.md) | Connect Feishu, use chat commands and navigate the workbench. |
| [Operations guide](operations.md) | Configure permissions, troubleshoot failures, manage upgrades and migrate installations. |
| [Architecture](architecture.md) | Follow a message through the system and find the modules and invariants behind each step. |
| [Development roadmap](development-plan.md) | Historical implementation status, acceptance gaps and priorities. |

The detailed references are maintained in English. Earlier designs and acceptance records remain in Git. Use these commands to inspect the archive at `adc53b8`.

```sh
git ls-tree --name-only adc53b8:docs/archive
git show adc53b8:docs/archive/p0-live-delivery-20261027.md
```
