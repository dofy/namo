import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

export class Cancelled extends Error { constructor() { super('初始化已取消；已保存的步骤可通过 namo init 继续'); } }
export interface Prompter {
  signal?: AbortSignal;
  text(label: string, initial?: string, secret?: boolean): Promise<string>;
  confirm(label: string, initial?: boolean): Promise<boolean>;
  info(message: string): void;
  close(): void;
}
export class TerminalPrompter implements Prompter {
  private muted = false;
  private abort = new AbortController();
  readonly signal = this.abort.signal;
  private output = new Writable({ write: (chunk, _encoding, done) => { if (!this.muted) process.stdout.write(chunk); done(); } });
  private rl = createInterface({ input: process.stdin, output: this.output, terminal: true });
  constructor() { this.rl.on('SIGINT', () => { this.abort.abort(); this.rl.close(); }); }
  info(message: string): void { process.stdout.write(message + '\n'); }
  async text(label: string, initial = '', secret = false): Promise<string> {
    if (secret) {
      // Readline still handles editing; its echo goes to a muted stream.
      process.stdout.write(`${label}${initial ? '（回车保留已有值）' : ''}：`);
      this.muted = true;
    }
    try {
      const value = await this.rl.question(secret ? '' : `${label}${initial ? ` [${initial}]` : ''}：`);
      return value.trim() || initial;
    } catch { throw new Cancelled(); }
    finally { if (secret) { this.muted = false; process.stdout.write('\n'); } }
  }
  async confirm(label: string, initial = false): Promise<boolean> {
    for (;;) {
      const v = (await this.text(`${label} ${initial ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
      if (!v) return initial;
      if (['y', 'yes', '是'].includes(v)) return true;
      if (['n', 'no', '否'].includes(v)) return false;
      this.info('请输入 y 或 n。');
    }
  }
  close(): void { this.rl.close(); }
}
