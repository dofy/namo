import { realpathSync, statSync } from 'node:fs';
import type { Config } from './config.js';
import { findExecutable } from './agents.js';
import { resolveCodexBinary } from './codex-installation.js';
import { readCodexVersion } from './codex-distribution.js';

/** Bounded background probing keeps durable message acceptance synchronous. */
export class RuntimeVersions {
  private entries = new Map<string,{value:string|null; checkedAt:number; pending?:Promise<void>}>();
  constructor(private readonly probe=readCodexVersion, private readonly now=Date.now) {}
  get(config: Config['codex']): string | null {
    try {
      const bin=findExecutable(resolveCodexBinary(config.bin,config.home));
      if(!bin)return null;
      const path=realpathSync(bin),stat=statSync(path),key=JSON.stringify([config.home,path,stat.dev,stat.ino,stat.size,stat.mtimeMs]);
      let entry=this.entries.get(key);
      if(!entry) { entry={value:null,checkedAt:0};this.entries.set(key,entry); }
      if(!entry.pending && (!entry.checkedAt || this.now()-entry.checkedAt>=60_000)) {
        const target=entry;
        target.pending=this.probe(path,config.home).then(value=>{target.value=value;target.checkedAt=this.now();})
          .catch(()=>{target.value=null;target.checkedAt=this.now();}).finally(()=>{target.pending=undefined;});
      }
      return entry.value;
    } catch { return null; }
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.entries.values()].map(e=>e.pending)); }
}
