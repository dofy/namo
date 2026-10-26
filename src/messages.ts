export interface Material {
  type: string;
  text?: string;
  resourceKey?: string;
  name?: string;
  limitation?: string;
}

// A bounded projection, not a raw SDK event. Never persist credentials here.
export interface Envelope {
  version: 1;
  type: string;
  kind: 'instruction' | 'material';
  scopeKey: string;
  threadId?: string;
  parentId?: string;
  rootId?: string;
  sentAt?: number;
  materials: Material[];
  limitations: string[];
}
