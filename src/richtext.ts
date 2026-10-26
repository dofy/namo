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
export const hasMarkdown=(text:string)=> /(?:\*\*|`|\[[^\]]+\]\(|(?:^|\n)(?:#{1,6}|[-*]|[0-9]+\.)\s)/.test(text);
export const plainMessage=(text:string)=>text.replace(/<(?=\/?at\b)/gi,'<\u200b');
export function fenceState(text:string):boolean {return (text.match(/^\s*```/gm)?.length??0)%2===1;}
export function safeMarkdown(text:string):string {
  // Escape platform tags before Markdown parsing; images never trigger URL fetches.
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/!\[([^\]\n]*)\]\([^\n)]*\)/g,'[image: $1]')
    .replace(/\[([^\]\n]+)\]\(([^\n)]*)\)/g,(whole,label:string,href:string)=>{
      try {const url=new URL(href);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?whole:label;}catch{return label;}
    });
}
export function richPost(text: string, initiallyFenced = false): object {
  const framed=(initiallyFenced?'```\n':'')+text;
  const balanced=framed+(fenceState(framed)?'\n```':'');
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
