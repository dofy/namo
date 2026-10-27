import { probeClaudeAgent, probeCursorAcp } from '../src/agent-probes.js';

interface Args {
  claudeBin?: string;
  claudeHome?: string;
  claudeConfigDir?: string;
  cursorBin?: string;
  cursorHome?: string;
  claudeSdkPackageJson?: string;
  cursorConfigDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function parseArgs(argv: string[]): Args {
  const result: Args = {};
  const values = new Map<string, keyof Args>([
    ['--claude-bin', 'claudeBin'],
    ['--claude-home', 'claudeHome'],
    ['--claude-config-dir', 'claudeConfigDir'],
    ['--cursor-bin', 'cursorBin'],
    ['--cursor-home', 'cursorHome'],
    ['--claude-sdk-package-json', 'claudeSdkPackageJson'],
    ['--cursor-config-dir', 'cursorConfigDir'],
    ['--timeout-ms', 'timeoutMs'],
    ['--max-output-bytes', 'maxOutputBytes'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = values.get(argv[index]);
    if (!key) throw new Error('unknown_probe_argument');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('missing_probe_argument_value');
    index += 1;
    if (key === 'timeoutMs' || key === 'maxOutputBytes') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error('invalid_probe_number');
      result[key] = parsed;
    } else {
      result[key] = value;
    }
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const common = { timeoutMs: args.timeoutMs, maxOutputBytes: args.maxOutputBytes };
  const [claude, cursor] = await Promise.all([
    probeClaudeAgent({ ...common, bin: args.claudeBin, home: args.claudeHome, configDir: args.claudeConfigDir,
      sdkPackageJson: args.claudeSdkPackageJson }),
    probeCursorAcp({ ...common, bin: args.cursorBin, home: args.cursorHome, configDir: args.cursorConfigDir }),
  ]);
  console.log(JSON.stringify({ schemaVersion: 1, inferenceAttempted: false, reports: [claude, cursor] }, null, 2));
} catch (error) {
  const code = error instanceof Error && /^[_a-z]+$/.test(error.message) ? error.message : 'agent_probe_failed';
  console.error(code);
  process.exitCode = 1;
}
