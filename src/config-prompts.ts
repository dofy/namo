import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { Writable } from 'node:stream';
import { Cancelled, type Prompter } from './prompts.js';
import { t } from './locale.js';

export class Back extends Error {}
export class Home extends Error { constructor(readonly confirmed=false){super();} }
export interface Option { value: string; label: string; detail?: string; changed?: boolean; action?: boolean; shortcut?: string; targeted?: boolean; availableActions?: string[]; hidden?: boolean; disabled?: boolean }
export interface ConfigPrompter extends Prompter { select(label: string, options: Option[], initial?: string, mode?:'root'): Promise<string>; screen?(): void; summary?(rows: [string,string][][]): void; }
export const selectedAction=(action:string,selected:string):string=>`$target:${JSON.stringify([action,selected])}`;
export function parseSelectedAction(value:string):[string,string]|undefined {
  if(!value.startsWith('$target:'))return;
  try{const parsed:unknown=JSON.parse(value.slice(8));if(Array.isArray(parsed)&&parsed.length===2&&parsed.every(item=>typeof item==='string'))return parsed as [string,string];}catch{/* Invalid input is not an action. */}
}

export function menuNavigation(key:{name?:string;ctrl?:boolean;meta?:boolean;shift?:boolean}, awaitingG:boolean, mode?:'root'): 'up'|'down'|'first'|'last'|'back'|'home'|'accept'|'prefix'|undefined {
  // Node marks a standalone Escape as meta, too; handle it before filtering Alt combinations.
  if (key.name==='escape' && !key.ctrl) return 'back';
  if (key.ctrl || key.meta) return;
  if (mode!=='root' && !key.shift && key.name==='h') return 'home';
  if (mode!=='root' && key.name==='left') return 'back';
  if (key.name==='return' || key.name==='enter' || key.name==='right' || (!key.shift && key.name==='l')) return 'accept';
  if (key.name==='up' || (!key.shift && key.name==='k')) return 'up';
  if (key.name==='down' || (!key.shift && key.name==='j')) return 'down';
  if (key.name==='g') return key.shift ? 'last' : awaitingG ? 'first' : 'prefix';
}

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
export function formatTerminalSummary(rows:[string,string][][],columns:number,paint:(code:string,text:string)=>string=(_code,text)=>text):string[] {
  const clean=(value:string)=>value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,' ');
  const safe=rows.map(row=>row.map(([key,value])=>[clean(key),clean(value)] as [string,string]));
  const keyWidths=[0,1].map(column=>Math.max(0,...safe.map(row=>terminalCellWidth(row[column]?.[0]??''))));
  const leftWidth=Math.max(0,...safe.map(row=>keyWidths[0]+2+terminalCellWidth(row[0]?.[1]??'')));
  const rightWidth=Math.max(0,...safe.map(row=>keyWidths[1]+2+terminalCellWidth(row[1]?.[1]??'')));
  const twoColumns=2+leftWidth+4+rightWidth<=columns-1;
  const pair=([key,value]:[string,string],width:number)=>paint('2',key+' '.repeat(Math.max(0,width-terminalCellWidth(key))))+paint('2',': ')+paint('1',value);
  return safe.flatMap(row=>{
    if(twoColumns && row.length===2){const used=keyWidths[0]+2+terminalCellWidth(row[0][1]);return ['  '+pair(row[0],keyWidths[0])+' '.repeat(leftWidth-used+4)+pair(row[1],keyWidths[1])];}
    return row.map(item=>'  '+pair(item,Math.max(...keyWidths)));
  });
}

/** An isolated prompt implementation so the initialization wizard retains its existing behavior. */
export class ConfigTerminalPrompter implements ConfigPrompter {
  private abort = new AbortController();
  readonly signal = this.abort.signal;
  private color = !!process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  private alternate = !!process.stdout.isTTY && process.env.TERM !== 'dumb';
  private restored = false;
  private cursorHidden = false;
  private screenMessages: string[] = [];
  private readonly onExit = () => this.restore();
  private readonly onTerminate = () => { this.restore(); process.kill(process.pid, 'SIGTERM'); };
  constructor() {
    if (this.alternate) { process.stdout.write('\x1b[?1049h'); process.once('exit', this.onExit); process.once('SIGTERM', this.onTerminate); }
  }
  private restore(): void {
    if (this.restored) return; this.restored = true;
    process.removeListener('exit', this.onExit); process.removeListener('SIGTERM', this.onTerminate);
    this.showCursor();
    if (this.alternate) process.stdout.write('\x1b[?1049l');
  }
  private hideCursor(): void { if (this.alternate && !this.cursorHidden) { this.cursorHidden=true; process.stdout.write('\x1b[?25l'); } }
  private showCursor(): void { if (this.cursorHidden) { this.cursorHidden=false; process.stdout.write('\x1b[?25h'); } }
  screen(): void { this.screenMessages = []; if (this.alternate) process.stdout.write('\x1b[2J\x1b[H'); }
  private paint(code: string, text: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  info(message: string): void {
    const lines=message.split('\n');
    const formatted=lines.map((line,index)=>index===0&&line.startsWith('NAMO //')?this.paint('1;38;5;215',line):line.startsWith('↩')?this.paint('38;5;114',line):line).join('\n');
    this.screenMessages.push(formatted); process.stdout.write(formatted + '\n');
  }
  summary(rows:[string,string][][]):void {
    this.info('NAMO // CONFIG\n');
    for(const line of formatTerminalSummary(rows,process.stdout.columns||80,(code,text)=>this.paint(code,text)))this.info(line);
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
  async select(label: string, options: Option[], initial?: string, mode?:'root'): Promise<string> {
    const choices=options.filter(option=>!option.action),actions=options.filter(option=>option.action);
    const visibleActions=actions.filter(action=>!action.hidden);
    if (!choices.length) throw new Error('empty_menu');
    let index = Math.max(0, choices.findIndex(option=>option.value===initial));
    const stdin = process.stdin, wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin); stdin.setRawMode(true); stdin.resume();
    const footerLines=()=>{
      if(!visibleActions.length)return [] as string[];
      const columns=Math.max(1,(process.stdout.columns||80)-1);
      const labels=visibleActions.map(action=>{
        const disabled=action.targeted&&!choices[index].availableActions?.includes(action.value);
        const plain=`[${action.shortcut??''}]${disabled?'×':' '} ${action.label}`;
        return {plain:fitTerminalLine(plain,Math.max(1,columns-2)),disabled};
      });
      const lines:string[]=[];let parts:typeof labels=[];let width=2;
      const flush=()=>{if(parts.length)lines.push('  '+parts.map(part=>this.paint(part.disabled?'2':'38;5;215',part.plain)).join('    '));parts=[];width=2;};
      for(const label of labels){const next=terminalCellWidth(label.plain)+(parts.length?4:0);if(parts.length&&width+next>columns)flush();width+=terminalCellWidth(label.plain)+(parts.length?4:0);parts.push(label);}
      flush();return lines;
    };
    const menuHeight=()=>{
      const columns=Math.max(1,process.stdout.columns||80);
      const used=this.screenMessages.flatMap(message=>message.split('\n')).reduce((sum,line)=>{
        const plain=line.replace(/\x1b\[[0-9;]*m/g,'');return sum+Math.max(1,Math.ceil(terminalCellWidth(plain)/columns));
      },0);
      return Math.max(1,Math.min(choices.length,(process.stdout.rows||24)-used-1-(visibleActions.length?1+footerLines().length:0)));
    };
    let visible = 1;
    let start = 0, awaitingG = false;
    const render = (redraw: boolean, previous?:number) => {
      const oldStart=start;
      if (index < start) start = index; else if (index >= start + visible) start = index - visible + 1;
      const footer=visibleActions.length?1+footerLines().length:0;
      const row=(i:number)=>{
        const option=choices[i],columns=Math.max(1,(process.stdout.columns || 80)-1);
        const fieldWidth=Math.min(28,Math.max(0,...choices.filter(o=>o.detail!==undefined).map(o=>terminalCellWidth(o.label))));
        const label=option.detail===undefined ? option.label : `${option.label}${' '.repeat(Math.max(1,fieldWidth-terminalCellWidth(option.label)+2))}│  ${option.detail}`;
        const marker=option.changed?'● ':'  ';
        const line=fitTerminalLine(`${i===index?'  ›':'   '} ${marker}${label}`,columns);
        const highlightWidth=Math.min(columns,Math.max(32,...choices.map(o=>terminalCellWidth(o.label)+(o.detail===undefined?0:terminalCellWidth(o.detail)+4)+8)));
        const padding=' '.repeat(Math.max(0,highlightWidth-terminalCellWidth(line)));
        return '\x1b[1G\x1b[2K'+(i===index ? this.paint('1;38;5;230;48;5;237',line+padding) : line);
      };
      if(redraw && previous!==undefined && oldStart===start && previous>=start && previous<start+visible){
        const indices=[previous,index].filter((value,pos,all)=>all.indexOf(value)===pos).sort((a,b)=>a-b);
        let position=start+visible+footer,output='';
        for(const i of indices){const distance=position-i;if(distance>0)output+=`\x1b[${distance}A`;else if(distance<0)output+=`\x1b[${-distance}B`;output+=row(i);position=i;}
        if(footer){
          const first=start+visible+1,distance=first-position;if(distance>0)output+=`\x1b[${distance}B`;
          position=first;
          for(const [i,line] of footerLines().entries()){if(i){output+='\x1b[1B';position++;}output+='\x1b[1G\x1b[2K'+line;}
        }
        const down=start+visible+footer-position;if(down>0)output+=`\x1b[${down}B`;
        process.stdout.write(output);return;
      }
      let output=redraw?`\x1b[${visible+footer}A`:'';
      for (let i=start;i<start+visible;i++) output+=row(i)+'\n';
      if(visibleActions.length){
        output+='\x1b[1G\x1b[2K'+this.paint('2','  '+ '─'.repeat(Math.min(58,Math.max(0,(process.stdout.columns||80)-4))))+'\n';
        for(const line of footerLines()){
          output+='\x1b[1G\x1b[2K'+line+'\n';
        }
      }
      process.stdout.write(output);
    };
    try {
      this.hideCursor();
      this.info(`\n${this.paint('1;38;5;215',label)}\n${this.paint('2',t(mode==='root'?'terminal.rootNavigation':'terminal.navigation'))}`); visible=menuHeight(); render(false);
      return await new Promise<string>((resolve,reject)=>{
        const onResize=()=>{
          if(!this.alternate)return;
          process.stdout.write('\x1b[2J\x1b[H' + this.screenMessages.join('\n') + '\n');
          visible=menuHeight();
          start=Math.min(start,choices.length-visible);render(false);
        };
        const cleanup=()=>{stdin.off('keypress',onKey);process.stdout.off('resize',onResize);this.signal.removeEventListener('abort',onAbort);};
        const onAbort=()=>{cleanup();reject(new Cancelled());};
        const onKey=(_value:string|undefined,key:{name?:string;ctrl?:boolean;meta?:boolean;shift?:boolean})=>{
          if (key?.ctrl && key.name==='c') { cleanup(); this.abort.abort(); reject(new Cancelled()); return; }
          const action=actions.find(option=>option.shortcut?.toLowerCase()===key?.name && !key?.ctrl && !key?.meta);
          if(action){
            const selected=choices[index];
            if(action.targeted && !selected.availableActions?.includes(action.value))return;
            cleanup();resolve(action.targeted?selectedAction(action.value,selected.value):action.value);return;
          }
          const navigation=menuNavigation(key??{},awaitingG,mode); awaitingG=navigation==='prefix';
          if (navigation==='back') { cleanup(); reject(new Back()); return; }
          if (navigation==='home') { cleanup(); reject(new Home()); return; }
          if (navigation==='accept') { if(choices[index].disabled)return;cleanup(); resolve(choices[index].value); return; }
          const previous=index;
          if (navigation==='up' || navigation==='down') index=(index+(navigation==='up'?-1:1)+choices.length)%choices.length;
          else if (navigation==='first') index=0;
          else if (navigation==='last') index=choices.length-1;
          else return;
          if(index!==previous)render(true,previous);
        };
        stdin.on('keypress',onKey);process.stdout.on('resize',onResize);this.signal.addEventListener('abort',onAbort,{once:true});
        if (this.signal.aborted) onAbort();
      });
    } finally { this.showCursor(); stdin.setRawMode(!!wasRaw); stdin.pause(); }
  }
}
