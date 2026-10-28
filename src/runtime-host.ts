import type { Incoming } from './store.js';
import type { CardEvent } from './cards.js';

export interface HostedRuntime {
  accept(message: Incoming, defer?: boolean): boolean;
  acceptCard(event: CardEvent): { toast: { type: 'info' | 'error'; content: string } };
  start(paused?: boolean): void;
  resume(): void;
  stop(): Promise<void>;
}
export type RuntimeFactory = () => HostedRuntime;

/** The receiver outlives each runtime. Deferred accepts still commit to SQLite
 * before the transport can acknowledge the event. Only one runtime may dispatch. */
export class RuntimeHost {
  private runtime: HostedRuntime;
  private switching?: Promise<void>;
  private closing = false;
  private unavailable = false;
  constructor(private factory: RuntimeFactory) { this.runtime = factory(); }
  get available(): boolean { return !this.unavailable; }
  start(): void { this.runtime.start(); }
  accept(message: Incoming): boolean {
    return this.runtime.accept(message, !!this.switching || this.closing || this.unavailable);
  }
  acceptCard(event: CardEvent): ReturnType<HostedRuntime['acceptCard']> {
    if (this.switching || this.closing || this.unavailable) return { toast: { type: 'error', content: '正在更新，消息仍会保存。请稍后重新点击。' } };
    return this.runtime.acceptCard(event);
  }
  replace(factory: RuntimeFactory, commit: () => void): Promise<void> {
    if (this.switching || this.closing || this.unavailable) return Promise.reject(Error('live_upgrade_busy'));
    // Defer the first operation until switching is set, including synchronous callbacks.
    const operation = Promise.resolve().then(async () => {
      const previous = this.factory;
      try { await this.runtime.stop(); }
      catch { this.unavailable = true; throw Error('live_upgrade_runtime_unsettled'); }
      let next: HostedRuntime | undefined;
      try {
        if (this.closing) throw Error('live_upgrade_closing');
        next = factory();
        next.start(true);
        commit();
      } catch (error) {
        try {
          await next?.stop();
          this.runtime = previous();
          this.runtime.start(true);
        } catch { this.unavailable = true; throw Error('live_upgrade_runtime_unsettled'); }
        throw error;
      }
      this.runtime = next;
      this.factory = factory;
    });
    this.switching = operation.finally(() => {
      this.switching = undefined;
      if (!this.closing && !this.unavailable) this.runtime.resume();
    });
    return this.switching;
  }
  async stop(): Promise<void> {
    this.closing = true;
    try { await this.switching; } catch { /* The restored runtime must also stop. */ }
    await this.runtime.stop();
  }
}
