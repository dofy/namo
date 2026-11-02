import { createHash } from 'node:crypto';
/** Read old configuration without retaining named-resource semantics in the runtime. */
export function directoryConfiguration(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const next=structuredClone(raw);next.codex??={};
  const c=next.codex;
  if(c.projects!==undefined&&(!c.projects||typeof c.projects!=='object'||Array.isArray(c.projects)))throw Error('legacy_configuration_invalid');
  if(c.directories===undefined)c.directories=[...new Set(Object.values(c.projects??{}))];
  for(const key of ['projects','projectAccess','defaultProject','readPaths'])delete c[key];
  if(Array.isArray(next.mcpConnections))next.mcpConnections=next.mcpConnections.map((entry:any)=>{
    const value={...entry};for(const key of ['enabled','audience','projects'])delete value[key];return value;
  });
  return next;
}

/** v15 read receipts hashed the historical task label, including null. */
export function legacyMcpIdentity(resource:unknown,appId:string,tenant:unknown,owner:string,chat:string,context:string|null):string {
  return createHash('sha256').update(JSON.stringify({resource,appId,tenant,owner,chat,project:context})).digest('hex');
}
