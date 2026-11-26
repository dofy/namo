import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { ClaudeUpdates } from './claude-updates.js';
import { CodexUpdates } from './codex-updates.js';
import { digest } from './paths.js';

interface ScheduledUpdater {
  tick(): Promise<void>;
  close(): Promise<void>;
}

export function startCliAutoUpdates(config: Config, revision: string, updaters?: readonly ScheduledUpdater[]): () => Promise<void> {
  const scheduled = updaters ?? providers(config, revision);
  let running: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const tick = () => {
    if (running || stopping) return;
    try { if (digest(readFileSync(config.file, 'utf8')) !== revision) return; }
    catch { return; }
    running = Promise.allSettled(scheduled.map(async updater => updater.tick()))
      .then(() => { running = undefined; });
  };

  const timer = setInterval(tick, 60_000);
  timer.unref();
  tick();

  return () => stopping ??= (async () => {
    clearInterval(timer);
    const [closed] = await Promise.all([
      Promise.allSettled(scheduled.map(async updater => updater.close())),
      running,
    ]);
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  })();
}

function providers(config: Config, revision: string): ScheduledUpdater[] {
  const claude = new ClaudeUpdates();
  return [
    new CodexUpdates(config, {}, revision),
    { tick: () => claude.tick(config, revision), close: () => claude.close() },
  ];
}
