/** Display-only parsing. Source answers remain unchanged in output_sources. */
type Node = { tag: 'text'; text: string; style?: string[] } | { tag: 'a'; text: string; href: string };
const literal = (text: string): Node => ({ tag: 'text', text });
export function inline(text: string): Node[] {
  const out: Node[] = []; const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > cursor) out.push(literal(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('`')) out.push({ tag: 'text', text: token.slice(1, -1), style: ['code'] });
    else if (token.startsWith('**')) out.push({ tag: 'text', text: token.slice(2, -2), style: ['bold'] });
    else { const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
      try { const url = new URL(link[2]); out.push(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? { tag: 'a', text: link[1], href: url.href } : literal(token)); }
      catch { out.push(literal(token)); }
    }
    cursor = match.index! + token.length;
  }
  if (cursor < text.length) out.push(literal(text.slice(cursor)));
  return out.length ? out : [literal(' ')];
}
export const hasMarkdown=(text:string)=> /(?:\*\*|`|~~|(?<!\w)_[^_\n]+_(?!\w)|(?<!\w)\*[^*\n]+\*(?!\w)|\[[^\]]+\]\(|(?:^|\n)\s{0,3}(?:#{1,6}\s|>\s?|[-+*]\s|[0-9]+[.)]\s|~{3,}|\|.*\|)|(?:^|\n)\s*:?-{3,}:?\s*\|)/.test(text);
export const plainMessage=(text:string)=>text.replace(/<(?=\/?at\b)/gi,'<\u200b');
export function openFence(text:string):string|undefined {
  let fence:string|undefined;
  for(const line of text.split('\n')){
    const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(!match)continue;
    if(!fence)fence=match[1];
    else if(match[1][0]===fence[0]&&match[1].length>=fence.length&&!match[2].trim())fence=undefined;
  }
  return fence;
}
export function fenceState(text:string):boolean {return !!openFence(text);}
const balanceFences=(text:string):string=>{const fence=openFence(text);return text+(fence?'\n'+fence:'');};
/** Transform prose only: code fences must keep their literal contents. */
function proseLines(text:string, transform:(line:string,index:number,lines:string[])=>string):string {
  let fence:{mark:string;length:number}|undefined;
  const lines=text.split('\n');
  return lines.map((line,index)=>{
    const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(fence){if(match&&match[1][0]===fence.mark&&match[1].length>=fence.length&&!match[2].trim())fence=undefined;return line;}
    if(match){fence={mark:match[1][0],length:match[1].length};return line;}
    return transform(line,index,lines);
  }).join('\n');
}
const safeLink=(href:string):boolean=>{try {const url=new URL(href);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}};
export function safeMarkdown(text:string):string {
  // Neutralize platform tags and images even in code: not every client supports
  // the same fence syntax. Retain > so ordinary blockquotes can still render.
  return text.split('\n').map(line=>{
    const definition=/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]*)>|(\S+))(?:\s+.*)?$/.exec(line);
    if(definition&&!safeLink(definition[2]??definition[3]))line=definition[1];
    return line.replace(/!\[([^\]\n]*)\](?:\([^\n)]*\)|\[[^\]\n]*\])?/g,'[image: $1]')
      .replace(/\[([^\]\n]+)\]\(([^\n)]*)\)/g,(whole,label:string,href:string)=>safeLink(href)?whole:label)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;');
  }).join('\n');
}
/** JSON 1.0 cards lack headings, blockquotes and Markdown tables. */
export function cardMarkdown(text:string):string {
  let table=false;
  const adapted=proseLines(text,(line,index,lines)=>{
    const separator=/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[index+1]??'');
    const starts=line.includes('|')&&separator;
    if(starts||table&&line.includes('|')){
      const prefix=table?'':'```text\n';table=true;
      const next=lines[index+1]??'';
      if(!next.includes('|')||/^ {0,3}(`{3,}|~{3,})/.test(next)){table=false;return prefix+line+'\n```';}
      return prefix+line;
    }
    const prefix=table?'```\n':'';table=false;
    return prefix+line.replace(/^ {0,3}#{1,6}[ \t]+(.+?)\s*$/,(_match,title:string)=>`**${title.replace(/[ \t]+#+[ \t]*$/,'')}**`).replace(/^ {0,3}>\s?/,'│ ');
  });
  return safeMarkdown(balanceFences(adapted));
}
export function richPost(text: string, initiallyFenced: boolean|string = false): object {
  const framed=(initiallyFenced?(typeof initiallyFenced==='string'?initiallyFenced:'```')+'\n':'')+text;
  const balanced=balanceFences(framed);
  return {zh_cn:{title:'',content:[[{tag:'md',text:safeMarkdown(balanced)}]]}};
}
/** Bound serialized payload bytes, split at lines first, retain source character order. */
export function splitDisplay(text: string, maxBytes = 12_000): string[] {
  if (!text) return [];
  const result: string[] = []; let chunk = '';
  const fits = (value: string) => Array.from(value).length <= 2000 && Buffer.byteLength(JSON.stringify(richPost(value))) <= maxBytes;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fits(chunk + line)) { chunk += line; continue; }
    if (chunk) { result.push(chunk); chunk = ''; }
    if (fits(line)) { chunk = line; continue; }
    // An oversized atom is displayed literally in bounded slices; no URL is fetched.
    const atoms=line.match(/!?\[[^\]\n]+\]\([^\n)]*\)|`[^`\n]+`|\*\*[^*\n]+\*\*|[^\s]+|\s+/g)??[line];
    for(const atom of atoms){if(fits(chunk+atom)){chunk+=atom;continue;}if(chunk){result.push(chunk);chunk='';}if(fits(atom)){chunk=atom;continue;}
      for(const char of atom){if(!fits(chunk+char)){result.push(chunk);chunk='';}chunk+=char;}
    }
  }
  if (chunk) result.push(chunk);
  return result;
}
