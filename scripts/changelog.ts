import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { AutomaticChange, AutomaticChangelog, AutomaticRelease, ChangelogKind } from '../src/changelog-contract.js';

const baseline = '0.2.0';
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const known: Record<string, AutomaticChange['known']> = { f2acbbf:'changelogPage', '18ef06e':'compactTasks' };
const kind: Record<string, ChangelogKind> = { feat:'feature',fix:'fix',perf:'performance',style:'style' };

function git(root:string,args:string[]): string | undefined {
  const result=spawnSync('git',['--no-pager',...args],{cwd:root,encoding:'utf8',timeout:5000,maxBuffer:2_000_000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,LC_ALL:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'}});
  return result.status===0 && !result.error ? result.stdout : undefined;
}
function packageVersion(root:string,hash:string):string|undefined {
  try {const value=JSON.parse(git(root,['show',`${hash}:package.json`]) ?? 'null')?.version;
    return typeof value==='string'&&versionPattern.test(value)?value:undefined;
  } catch { return; }
}
function visibleChange(hash:string,subject:string):AutomaticChange|undefined {
  const match=/^(feat|fix|perf|style)(?:\([^\r\n()]{1,60}\))?!?:\s+(.+)$/.exec(subject);
  if(!match)return;
  const text=match[2].trim();
  // History becomes product-visible; omit suspicious subjects rather than leak credentials or local paths.
  if(!text || text.length>180 || /[\x00-\x1f\x7f]|(?:sk-|gh[pousr]_|github_pat_|eyJ[A-Za-z0-9_-]{12})|(?:password|secret|api.?key|access.?token|private.?key)|(?:https?:\/\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\s)(?:\/Users\/|\/home\/|\/private\/)|config\.local\.json|\bdata\/)/i.test(text)) return;
  const entry:AutomaticChange={id:hash,kind:kind[match[1]],text};
  const curated=known[hash.slice(0,7)];if(curated)entry.known=curated;
  return entry;
}

/** Derive post-baseline releases from committed first-parent history, never from diffs or credentials. */
export function generateChangelog(root:string,currentVersion:string): AutomaticChangelog {
  const fallback:AutomaticChangelog={source:'fallback',releases:[]};
  if(!versionPattern.test(currentVersion))return fallback;
  try {
    const top=git(root,['rev-parse','--show-toplevel'])?.trim();
    if(!top || realpathSync(top)!==realpathSync(root) || git(root,['rev-parse','--is-shallow-repository'])?.trim()!=='false')return fallback;
    const versions=git(root,['log','--first-parent','--format=%H','--','package.json']);
    if(!versions)return fallback;
    const boundaries:{hash:string;version:string}[]=[];let lastVersion:string|undefined;
    // Version changes follow the release branch; entries also include merged feature commits.
    const changes=versions.trim().split('\n').reverse();
    if(changes.length>200)return fallback;
    for(const hash of changes) {const v=packageVersion(root,hash);if(!v)return fallback;if(v!==lastVersion){boundaries.push({hash,version:v});lastVersion=v;}}
    const baselineIndex=boundaries.findIndex(entry=>entry.version===baseline);
    if(baselineIndex<0)return fallback;
    const range=(base:string,head:string):{date:string|null;changes:AutomaticChange[]} => {
      const output=git(root,['log','--no-merges','--topo-order','--max-count=1001','--format=%H%x09%cI%x09%s',`${base}..${head}`]);
      if(output===undefined)throw Error('history_unavailable');
      const lines=output.trim()?output.trim().split('\n'):[];if(lines.length>1000)throw Error('history_too_large');
      const result:AutomaticChange[]=[];let lastDate:string|null=null;
      for(const line of lines){const [hash,date,...rest]=line.split('\t');
        if(!/^[a-f0-9]{40,64}$/.test(hash)||!/^\d{4}-\d{2}-\d{2}T/.test(date))throw Error('history_invalid');
        const item=visibleChange(hash,rest.join('\t'));if(item){result.push(item);lastDate??=date.slice(0,10);}}
      return {date:lastDate,changes:result};
    };
    const releases:AutomaticRelease[]=[];
    const latest=boundaries.at(-1)!;
    const pending=range(latest.hash,'HEAD');
    if(pending.changes.length||currentVersion!==latest.version)
      releases.push({version:currentVersion===latest.version?null:currentVersion,date:currentVersion===latest.version?pending.date:null,changes:pending.changes});
    for(let i=boundaries.length-1;i>baselineIndex;i--) {
      const release=boundaries[i],before=boundaries[i-1];
      const date=git(root,['show','-s','--format=%cI',release.hash])?.trim();
      if(!date || !/^\d{4}-\d{2}-\d{2}T/.test(date))return fallback;
      releases.push({version:release.version,date:date.slice(0,10),changes:range(before.hash,release.hash).changes});
    }
    return {source:'git',releases};
  } catch {return fallback;}
}
