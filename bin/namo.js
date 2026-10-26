#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 15)) {
  console.error(`Namo 需要 Node.js 24.15+；当前为 ${process.version}。请先安装受支持的 Node.js。`);
  process.exit(1);
}
await import('../dist/src/cli.js');
