import { t as tr, currentLocale } from './locale.js';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

export class Cancelled extends Error { constructor() { super(tr("prompts.setupCancelledRunNamoInitResumeSaved")); } }
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
    const separator = currentLocale() === 'en' ? ': ' : '：';
    if (secret) {
      // Readline still handles editing; its echo goes to a muted stream.
      process.stdout.write(`${label}${initial ? tr("prompts.pressEnterKeepExistingValue") : ''}${separator}`);
      this.muted = true;
    }
    try {
      const value = await this.rl.question(secret ? '' : `${label}${initial ? ` [${initial}]` : ''}${separator}`);
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
      this.info(tr("prompts.enterYN"));
    }
  }
  close(): void { this.rl.close(); }
}
