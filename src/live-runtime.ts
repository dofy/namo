import { Engine, SendError, type Sender } from './engine.js';
import { RunnerRuntime } from './runner.js';
import { SCHEMA_VERSION, type Store } from './store.js';
import type { Config } from './config.js';
import { withLocale } from './locale.js';
import type { HostedRuntime } from './runtime-host.js';

export const liveRuntimeAbi = 1;
export const schemaVersion = SCHEMA_VERSION;
export interface LiveRuntimeOptions {
  store: Store; config: Config; sender: Sender;
  redact: (text: string) => string;
  log: (event: string, fields?: Record<string, unknown>) => void;
  onFatal: () => void;
}
export function createLiveRuntime(options: LiveRuntimeOptions): HostedRuntime {
  // Error classes belong to their immutable module graph. Translate the trusted
  // transport's receipt at this boundary so safe rejection remains distinguishable
  // from an ambiguous send after loading a different release.
  const sender = new Proxy(options.sender, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      try { return await value.apply(target, args); }
      catch (error) {
        const receipt = error as { unknown?: unknown; code?: unknown } | null;
        if (receipt && typeof receipt.unknown === 'boolean' && typeof receipt.code === 'string') throw new SendError(receipt.unknown, receipt.code);
        throw error;
      }
    };
  } });
  const engine = new Engine(options.store, new RunnerRuntime(options.store, options.config), sender,
    options.config, options.redact, options.log, options.onFatal);
  return {
    accept: (message, defer) => withLocale('zh-CN', () => engine.accept(message, defer)),
    acceptCard: event => withLocale('zh-CN', () => engine.acceptCard(event)),
    start: paused => withLocale('zh-CN', () => engine.start(paused)),
    resume: () => withLocale('zh-CN', () => engine.resume()),
    stop: () => engine.stop(),
  };
}
