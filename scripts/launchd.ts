import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { serviceAction } from '../src/service.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try { console.log(JSON.stringify(await serviceAction(process.argv[2] ?? 'install', loadConfig(resolve(root, 'config.local.json'))), null, 2)); }
catch { console.error('服务操作未完成。请运行 namo doctor / namo service status；配置与数据保留。'); process.exitCode = 1; }
