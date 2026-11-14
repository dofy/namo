# Namo documentation site

[简体中文](#简体中文) · [English](#english)

## 简体中文

在仓库根目录安装依赖并运行 `pnpm run build` 后，执行 `pnpm cli docs`；已安装 CLI 时使用 `namo docs`。命令会启动本地服务并打开浏览器，按 Ctrl+C 停止。开发文档站时也可使用 `pnpm docs:dev`。整个 `docs-site/` 可作为静态网站目录部署；当前未配置托管地址。

内容按章节在 `content.js` 中同时维护中英文，保留一致的章节 ID，以便语言切换和链接定位。项目中更细的 Markdown 实现及运维参考保留在 [`docs/`](../docs/)。

## English

After installing dependencies and running `pnpm run build`, use `pnpm cli docs` from the repository root, or `namo docs` with an installed CLI. The command starts a local server and opens your browser; press Ctrl+C to stop it. Use `pnpm docs:dev` when developing the site. The entire `docs-site/` directory can be deployed as a static site. No hosting address is configured yet.

Maintain the English and Chinese content together in `content.js` and keep section IDs stable for language switching and deep links. More detailed implementation and operations references remain in [`docs/`](../docs/).
