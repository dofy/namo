import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents, cursorTo, clearLine, moveCursor } from 'node:readline';
import { Writable } from 'node:stream';
import { Cancelled, type Prompter } from './prompts.js';
import { t } from './locale.js';

export class Back extends Error {}
export interface Option { value: string; label: string }
export interface ConfigPrompter extends Prompter { select(label: string, options: Option[], initial?: string): Promise<string>; screen?(): void; }


/** Bound menu lines by terminal cells, including CJK and emoji, to prevent wrapping during redraw. */
export function fitTerminalLine(value: string, width: number): string {
  const segments = new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(value);
  let result = '', cells = 0;
  for (const {segment} of segments) {
    const cp = segment.codePointAt(0) ?? 0;
    const size = /\p{Extended_Pictographic}/u.test(segment) || cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
    if (cells + size > width) break; result += segment; cells += size;
  }
  return result;
}

/** An isolated prompt implementation so the initialization wizard retains its existing behavior. */
export class ConfigTerminalPrompter implements ConfigPrompter {
  private abort = new AbortController();
  readonly signal = this.abort.signal;
  private color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  private alternate = !!process.stdout.isTTY && process.env.TERM !== 'dumb';
  private restored = false;
  private readonly onExit = () => this.restore();
  private readonly onTerminate = () => { this.restore(); process.kill(process.pid, 'SIGTERM'); };
  constructor() {
    if (this.alternate) { process.stdout.write('\x1b[?1049h'); process.once('exit', this.onExit); process.once('SIGTERM', this.onTerminate); }
  }
  private restore(): void {
    if (this.restored) return; this.restored = true;
    process.removeListener('exit', this.onExit); process.removeListener('SIGTERM', this.onTerminate);
    if (this.alternate) process.stdout.write('\x1b[?1049l');
  }
  screen(): void { if (this.alternate) process.stdout.write('\x1b[2J\x1b[H'); }
  private paint(code: string, text: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  info(message: string): void { process.stdout.write(message + '\n'); }
  close(): void { this.abort.abort(); this.restore(); }
  async text(label: string, initial = '', secret = false): Promise<string> {
    let muted = false;
    const output = new Writable({write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); }});
    const rl = createInterface({input:process.stdin,output,terminal:true});
    const controller = new AbortController();
    let back = false;
    const key = (_value: string | undefined, event: {name?:string}) => { if (event?.name === 'escape') { back = true; controller.abort(); } };
    const abort = () => controller.abort();
    process.stdin.on('keypress', key);
    this.signal.addEventListener('abort', abort, {once:true});
    rl.on('SIGINT', () => { this.abort.abort(); controller.abort(); });
    try {
      const prompt = `${this.paint('36','◆')} ${label}${!secret && initial ? ` [${initial}]` : ''} ${this.paint('2',t('terminal.escapeHint'))}: `;
      if (secret) { process.stdout.write(prompt); muted = true; }
      const value = await rl.question(secret ? '' : prompt, {signal:controller.signal});
      return value.trim() || initial;
    } catch {
      if (back) throw new Back();
      throw new Cancelled();
    } finally {
      process.stdin.off('keypress', key);
      this.signal.removeEventListener('abort', abort);
      rl.close();
      if (secret || back) process.stdout.write('\n');
    }
  }
  async confirm(label: string, initial = false): Promise<boolean> {
    return await this.select(label,[{value:'yes',label:t('terminal.yes')},{value:'no',label:t('terminal.no')}],initial?'yes':'no') === 'yes';
  }
  async select(label: string, options: Option[], initial?: string): Promise<string> {
    if (!options.length) throw new Error('empty_menu');
    let index = Math.max(0, options.findIndex(option=>option.value===initial));
    const stdin = process.stdin, wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
    const visible = Math.max(1, Math.min(options.length, (process.stdout.rows || 24) - 2));
    let start = 0;
    const render = (redraw: boolean) => {
      if (index < start) start = index; else if (index >= start + visible) start = index - visible + 1;
      if (redraw) moveCursor(process.stdout,0,-visible);
      for (let i=start;i<start+visible;i++) {
        cursorTo(process.stdout,0); clearLine(process.stdout,0);
        const line = fitTerminalLine(i===index ? `  ❯ ${options[i].label}` : `    ${options[i].label}`, Math.max(1,(process.stdout.columns || 80)-1));
        process.stdout.write(i===index ? this.paint('1;36',line) : line);
        process.stdout.write('\n');
      }
    };
    this.info(`\n${this.paint('1',label)} ${this.paint('2',t('terminal.navigation'))}`); render(false);
    try {
      return await new Promise<string>((resolve,reject)=>{
        const cleanup=()=>{stdin.off('keypress',onKey);this.signal.removeEventListener('abort',onAbort);};
        const onAbort=()=>{cleanup();reject(new Cancelled());};
        const onKey=(_value:string|undefined,key:{name?:string;ctrl?:boolean})=>{
          if (key?.ctrl && key.name==='c') { cleanup(); this.abort.abort(); reject(new Cancelled()); return; }
          if (key?.name==='escape' || key?.name==='left') { cleanup(); reject(new Back()); return; }
          if (key?.name==='up' || key?.name==='down') { index=(index+(key.name==='up'?-1:1)+options.length)%options.length; render(true); }
          else if (key?.name==='return' || key?.name==='enter' || key?.name==='right') { cleanup(); resolve(options[index].value); }
        };
        stdin.on('keypress',onKey);this.signal.addEventListener('abort',onAbort,{once:true});
        if (this.signal.aborted) onAbort();
      });
    } finally { stdin.setRawMode(!!wasRaw); stdin.pause(); }
  }
}
