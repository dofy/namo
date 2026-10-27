import type { ActivityPhase } from './task-progress.js';
import type { PublicProgressEvent } from './public-progress.js';
import type { EvidenceItem } from './ui-contract.js';
import type { ImageInput } from './image-inputs.js';
import type { ExternalWaitRequest } from './external-waits.js';
import type { AutoMemoryInput } from './auto-memory.js';

export interface RunRequest {
  taskId?: string; runId?: string;
  threadId?: string; cwd: string; prompt: string; signal: AbortSignal;
  images?: readonly ImageInput[];
  onThread: (id: string) => void; onTurn: (id: string) => void;
  onReady?: (controls: RunControls) => void;
  onWait?: (request: WaitRequest) => string;
  onReview?: (arguments_: unknown) => Promise<unknown>;
  onEvidence?: (item: EvidenceItem) => void;
  onActivity?: (phase: ActivityPhase) => void;
  onProgress?: (event: PublicProgressEvent) => void;
  onProcess?: (pid: number) => void;
}
export interface RunControls { steer(text: string): Promise<'accepted' | 'not_active' | 'rejected'>; }
export interface WaitRequest {
  threadId: string; turnId: string; callId: string; question: string; choices?: string[];
  /** Present only when Codex called the separately validated external-wait tool. */
  external?: ExternalWaitRequest;
}
export interface WaitResult extends WaitRequest { id: string; }
export interface RunResult { text: string; threadId: string; turnId: string; waiting?: WaitResult; }
export interface Runtime {
  /** Durable runtimes own their evidence and survive receiver detachment. */
  persistent?: boolean;
  run(request: RunRequest): Promise<RunResult>;
  reservations?(): { runId: string; chatKey: string; cwd: string }[];
  extractMemory?(input: AutoMemoryInput, signal: AbortSignal): Promise<unknown>;
}
export class RuntimeError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(code); }
}
