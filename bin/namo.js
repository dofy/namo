#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 15)) {
  const args = process.argv.slice(2);
  const language = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : process.env.NAMO_LANG;
  const selected = language && language !== 'system' ? language : process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  const chinese = /^zh(?:[-_.@]|$)/i.test(selected);
  console.error(chinese
    ? `Namo 需要 Node.js 24.15+；当前为 ${process.version}。请先安装受支持的 Node.js。`
    : `Namo requires Node.js 24.15+; current version: ${process.version}. Install a supported Node.js version first.`);
  process.exit(1);
}
await import('../dist/src/cli.js');
