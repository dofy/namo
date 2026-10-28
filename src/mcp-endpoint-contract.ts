/** Browser-safe endpoint identity. Paths (including trailing slashes) remain significant. */
export interface McpEndpoint {id:string;url:string}
export function mcpEndpointKey(url:string):string {
  try{return new URL(url).href;}catch{return '';}
}
export function duplicateMcpEndpoint(values:readonly McpEndpoint[],candidate:McpEndpoint):McpEndpoint|undefined {
  const key=mcpEndpointKey(candidate.url);
  return key?values.find(value=>value.id!==candidate.id&&mcpEndpointKey(value.url)===key):undefined;
}
/** Existing duplicates stay manageable; adding or moving another entry into a group is rejected. */
export function addsDuplicateMcpEndpoint(previous:readonly McpEndpoint[],next:readonly McpEndpoint[]):boolean {
  return next.some(value=>!previous.some(old=>old.id===value.id&&mcpEndpointKey(old.url)===mcpEndpointKey(value.url))&&!!duplicateMcpEndpoint(next,value));
}
