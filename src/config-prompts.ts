import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents, cursorTo, clearLine, moveCursor } from 'node:readline';
import { Writable } from 'node:stream';
import { Cancelled, type Prompter } from './prompts.js';
import { t } from './locale.js';

export class Back extends Error {}
export interface Option { value: string; label: string; detail?: string; changed?: boolean; action?: boolean; shortcut?: string }
export interface ConfigPrompter extends Prompter { select(label: string, options: Option[], initial?: string): Promise<string>; screen?(): void; }


/** Measure terminal cells by grapheme rather than JavaScript string length. */
function graphemeWidth(segment:string):number {
  const cp=segment.codePointAt(0)??0;
  return /\p{Extended_Pictographic}/u.test(segment) || cp>=0x1100 && (cp<=0x115f || cp>=0x2e80&&cp<=0xa4cf || cp>=0xac00&&cp<=0xd7a3 || cp>=0xf900&&cp<=0xfaff || cp>=0xfe10&&cp<=0xfe6f || cp>=0xff01&&cp<=0xff60 || cp>=0x20000&&cp<=0x3fffd) ? 2 : 1;
}
export function terminalCellWidth(value:string):number {
  let width=0;for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value))width+=graphemeWidth(segment);return width;
}
export function fitTerminalLine(value:string,width:number):string {
  let result='',cells=0;
  for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)) {
    const size=graphemeWidth(segment);if(cells+size>width)break;result+=segment;cells+=size;
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
  private screenMessages: string[] = [];
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
  screen(): void { this.screenMessages = []; if (this.alternate) process.stdout.write('\x1b[2J\x1b[H'); }
  private paint(code: string, text: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  info(message: string): void {
    const lines=message.split('\n');
    const formatted=lines.map((line,index)=>index===0&&line.startsWith('🧭')?this.paint('1;38;5;81',line):line.startsWith('↩')?this.paint('38;5;114',line):line).join('\n');
    this.screenMessages.push(formatted); process.stdout.write(formatted + '\n');
  }
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
      const displayedInitial = initial.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ');
      const prompt = `${this.paint('36','◆')} ${label}${!secret && initial ? ` [${displayedInitial}]` : ''} ${this.paint('2',t('terminal.escapeHint'))}: `;
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
    const choices=options.filter(option=>!option.action),actions=options.filter(option=>option.action);
    if (!choices.length) throw new Error('empty_menu');
    let index = Math.max(0, choices.findIndex(option=>option.value===initial));
    const stdin = process.stdin, wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
    const footerLines=()=>{
      if(!actions.length)return [] as string[];
      const columns=Math.max(1,(process.stdout.columns||80)-1);
      const labels=actions.map(action=>`[${action.shortcut??''}] ${action.label}`);
      const combined='  '+labels.join('    ');
      return terminalCellWidth(combined)<=columns?[combined]:labels.map(label=>'  '+label);
    };
    const menuHeight=()=>{
      const columns=Math.max(1,process.stdout.columns||80);
      const used=this.screenMessages.flatMap(message=>message.split('\n')).reduce((sum,line)=>{
        const plain=line.replace(/\x1b\[[0-9;]*m/g,'');return sum+Math.max(1,Math.ceil(terminalCellWidth(plain)/columns));
      },0);
      return Math.max(1,Math.min(choices.length,(process.stdout.rows||24)-used-1-(actions.length?1+footerLines().length:0)));
    };
    let visible = 1;
    let start = 0;
    const render = (redraw: boolean) => {
      if (index < start) start = index; else if (index >= start + visible) start = index - visible + 1;
      if (redraw) moveCursor(process.stdout,0,-visible-(actions.length?1+footerLines().length:0));
      for (let i=start;i<start+visible;i++) {
        cursorTo(process.stdout,0); clearLine(process.stdout,0);
        const option=choices[i],columns=Math.max(1,(process.stdout.columns || 80)-1);
        const fieldWidth=Math.min(28,Math.max(0,...choices.filter(o=>o.detail!==undefined).map(o=>terminalCellWidth(o.label))));
        const label=option.detail===undefined ? option.label : `${option.label}${' '.repeat(Math.max(1,fieldWidth-terminalCellWidth(option.label)+2))}│  ${option.detail}`;
        const marker=option.changed?'● ':'  ';
        const line=fitTerminalLine(`${i===index?'  ❯':'   '} ${marker}${label}`,columns);
        const highlightWidth=Math.min(columns,72);
        const padding=' '.repeat(Math.max(0,highlightWidth-terminalCellWidth(line)));
        process.stdout.write(i===index ? this.paint('1;38;5;231;48;5;24',line+padding) : this.paint('38;5;250',line));
        process.stdout.write('\n');
      }
      if(actions.length){
        cursorTo(process.stdout,0);clearLine(process.stdout,0);
        process.stdout.write(this.paint('2','  '+ '─'.repeat(Math.min(58,Math.max(0,(process.stdout.columns||80)-4))))+'\n');
        for(const line of footerLines()){
          cursorTo(process.stdout,0);clearLine(process.stdout,0);
          process.stdout.write(this.paint('1;38;5;81',fitTerminalLine(line,Math.max(1,(process.stdout.columns||80)-1)))+'\n');
        }
      }
    };
    this.info(`\n${this.paint('1;38;5;81',label)}\n${this.paint('2',t('terminal.navigation'))}`); visible=menuHeight(); render(false);
    try {
      return await new Promise<string>((resolve,reject)=>{
        const onResize=()=>{
          if(!this.alternate)return;
          process.stdout.write('\x1b[2J\x1b[H' + this.screenMessages.join('\n') + '\n');
          visible=menuHeight();
          start=Math.min(start,choices.length-visible);render(false);
        };
        const cleanup=()=>{stdin.off('keypress',onKey);process.stdout.off('resize',onResize);this.signal.removeEventListener('abort',onAbort);};
        const onAbort=()=>{cleanup();reject(new Cancelled());};
        const onKey=(_value:string|undefined,key:{name?:string;ctrl?:boolean})=>{
          if (key?.ctrl && key.name==='c') { cleanup(); this.abort.abort(); reject(new Cancelled()); return; }
          if (key?.name==='escape' || key?.name==='left') { cleanup(); reject(new Back()); return; }
          const action=actions.find(option=>option.shortcut?.toLowerCase()===key?.name && !key?.ctrl);
          if(action){cleanup();resolve(action.value);return;}
          if (key?.name==='up' || key?.name==='down') { index=(index+(key.name==='up'?-1:1)+choices.length)%choices.length; render(true); }
          else if (key?.name==='return' || key?.name==='enter' || key?.name==='right') { cleanup(); resolve(choices[index].value); }
        };
        stdin.on('keypress',onKey);process.stdout.on('resize',onResize);this.signal.addEventListener('abort',onAbort,{once:true});
        if (this.signal.aborted) onAbort();
      });
    } finally { stdin.setRawMode(!!wasRaw); stdin.pause(); }
  }
}
