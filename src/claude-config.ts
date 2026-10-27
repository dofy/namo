import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync, mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export type ClaudeAuth = { mode: 'official-login' } | { mode: 'official-api-key'; envFile: string }
  | { mode: 'router'; envFile: string; baseUrl: string };
export interface ClaudeConfig {
  bin: string; home: string; auth: ClaudeAuth; model?: string; timeoutMs: number;
  /** R7.2 validation only. Production selection remains unavailable until the compatibility gates pass. */
  validationRoot: string;
  toolSet?: 'files' | 'bounded-shell';
}
const keys = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL'];
export function readClaudeEnv(file: string): Record<string,string> {
  if (!isAbsolute(file)) throw new Error('claude_credentials_invalid');
  let fd: number | undefined;
  try {
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const s=fstatSync(fd);
    if(!s.isFile()||s.size>65536||(process.platform!=='win32'&&((s.mode&0o077)!==0||s.uid!==process.getuid?.())))throw new Error();
    const result:Record<string,string>={};
    for(const line of readFileSync(fd,'utf8').split(/\r?\n/)) {
      const match=line.match(/^\s*(?:export\s+)?(ANTHROPIC_[A-Z_]+)\s*=\s*(.*)$/);if(!match||!keys.includes(match[1]))continue;
      const literal=match[2].match(/^"([^"\\$`\r\n]*)"\s*(?:#.*)?$/);
      if(!literal||Object.hasOwn(result,match[1]))throw new Error();result[match[1]]=literal[1];
    }
    return result;
  } catch { throw new Error('claude_credentials_invalid'); } finally { if(fd!==undefined)closeSync(fd); }
}
export function validateClaudeConfig(c: ClaudeConfig): void {
  if(!c||!isAbsolute(c.bin)||!isAbsolute(c.home)||!isAbsolute(c.validationRoot)
    ||!Number.isSafeInteger(c.timeoutMs)||c.timeoutMs<1000||c.timeoutMs>300000
    ||c.model!==undefined&&(typeof c.model!=='string'||!c.model.trim()||c.model.length>256)
    ||c.toolSet!==undefined&&!['files','bounded-shell'].includes(c.toolSet)
    ||!['official-login','official-api-key','router'].includes(c.auth?.mode))throw new Error('claude_config_invalid');
  if(c.auth.mode==='official-login') { if(Object.keys(c.auth).some(k=>k!=='mode'))throw new Error('claude_auth_mode_conflict'); }
  else if(!isAbsolute(c.auth.envFile))throw new Error('claude_config_invalid');
  if(c.auth.mode==='router') {
    const u=new URL(c.auth.baseUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('claude_router_invalid');
  }
}
export function privateClaudeDirectory(path:string):string {
  mkdirSync(path,{recursive:true,mode:0o700});const s=lstatSync(path);
  if(s.isSymbolicLink()||!s.isDirectory()||(process.platform!=='win32'&&((s.mode&0o077)!==0||s.uid!==process.getuid?.())))throw new Error('claude_home_not_private');
  return realpathSync(path);
}
export function withinClaudeWorkspace(root:string,path:string):boolean {
  const r=relative(root,path);return r!==''&&!r.startsWith('..')&&!isAbsolute(r);
}
export function claudeBaseEnvironment(home:string):NodeJS.ProcessEnv {
  return {HOME:home,CLAUDE_CONFIG_DIR:join(home,'config'),PATH:process.env.PATH??'/usr/bin:/bin',
    LANG:'en_US.UTF-8',TMPDIR:join(home,'tmp'),XDG_CONFIG_HOME:join(home,'xdg'),
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'};
}
export function claudeEnvironment(c:ClaudeConfig):NodeJS.ProcessEnv {
  validateClaudeConfig(c);const home=privateClaudeDirectory(c.home);
  for(const child of ['config','tmp','xdg'])privateClaudeDirectory(join(home,child));
  const marker=join(home,'.namo-auth-mode'),identity=JSON.stringify({mode:c.auth.mode,baseUrl:c.auth.mode==='router'?c.auth.baseUrl:undefined});
  if(existsSync(marker)){if(lstatSync(marker).isSymbolicLink()||readFileSync(marker,'utf8')!==identity)throw new Error('claude_auth_home_conflict');}
  else writeFileSync(marker,identity,{mode:0o600,flag:'wx'});
  const env=claudeBaseEnvironment(home);
  if(c.auth.mode==='official-login')return env;
  const source=readClaudeEnv(c.auth.envFile);
  if(c.auth.mode==='official-api-key') {
    if(source.ANTHROPIC_BASE_URL||source.ANTHROPIC_AUTH_TOKEN)throw new Error('claude_auth_mode_conflict');
    if(!source.ANTHROPIC_API_KEY)throw new Error('claude_api_key_missing');
    env.ANTHROPIC_API_KEY=source.ANTHROPIC_API_KEY; // Deliberately discard router URL/token/model.
  } else {
    if(source.ANTHROPIC_BASE_URL!==c.auth.baseUrl||!(source.ANTHROPIC_API_KEY||source.ANTHROPIC_AUTH_TOKEN))throw new Error('claude_router_credentials_mismatch');
    for(const key of keys)if(source[key])env[key]=source[key];
  }
  return env;
}
