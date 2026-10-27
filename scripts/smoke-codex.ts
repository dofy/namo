import { loadConfig } from '../src/config.js';
import { CodexRuntime, probeRuntime } from '../src/runtime.js';
import { chatWorkspace } from '../src/safety.js';

const config = loadConfig();
try {
  const probe = await probeRuntime(config.codex);
  console.log(JSON.stringify({ ...probe, modelTurnVerified: false }));
  if (process.argv.includes('--run')) {
    if (!probe.authenticated) throw new Error('请先 pnpm cli login，握手已通过但尚未验证模型推理。');
    const runtime = new CodexRuntime(config.codex);
    const run = await runtime.run({ cwd: chatWorkspace(config.dataDir, '__smoke__'),
      prompt: 'Do not call tools. Reply with exactly FEISHU_CODEX_SMOKE_OK.',
      signal: new AbortController().signal, onThread: () => {}, onTurn: () => {},
    });
    if (run.text !== 'FEISHU_CODEX_SMOKE_OK') throw new Error('模型回复未符合 smoke 断言');
    console.log(JSON.stringify({ modelTurnVerified: true, exactReply: true }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'smoke_failed'); process.exitCode = 1;
}
