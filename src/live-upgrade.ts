import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson, digest, readJson } from './paths.js';
import type { Config } from './config.js';
import { SCHEMA_VERSION } from './store.js';
import type { RuntimeRelease, ReleaseManifest } from './release.js';
import type { RuntimeFactory } from './runtime-host.js';
import type { LiveRuntimeOptions } from './live-runtime.js';
import { RuntimeHost } from './runtime-host.js';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const HOST_FILES = ['cli', 'service-bootstrap', 'runtime-host', 'live-upgrade', 'release-check',
  'feishu', 'access', 'store', 'schema', 'schema-migrations', 'config', 'paths', 'safety', 'richtext', 'codex-updates', 'codex-installation',
  // These modules read or write durable JSON shared with the pinned receiver.
  // A byte change requires restart until a versioned cross-release codec exists.
  'engine','tasks','waits','external-waits','external-wait-bridge','business-storage','runner','runner-store',
  'memory','memory-access','auto-memory','schedules','feedback','cards','mcp-connections','mcp-write-approval',
  'github-api','github-access','github-review','approval-service','approvals','recovery','artifact-delivery','inbox-retention',
  'assistant','profiles','model-preferences','task-progress','public-progress','evidence','artifacts','model-catalog',
  'task-context','image-inputs','memory-commands','memory-extractor','materials','task-materials','mcp-oauth'];

/** The receiver and storage implementation remain pinned until a deliberate
 * restart. This ABI supports execution-code changes, never schema migration. */
export function assertLiveCompatible(host: ReleaseManifest, candidate: ReleaseManifest): void {
  const required = new Set(HOST_FILES.map(name => `dist/src/${name}.js`));
  const stable = (manifest: ReleaseManifest) => manifest.files.filter(file => required.has(file.path) || file.path.startsWith('node_modules/'));
  if (HOST_FILES.some(name => !host.files.some(file => file.path === `dist/src/${name}.js`))
    || JSON.stringify(stable(host)) !== JSON.stringify(stable(candidate))) throw Error('live_upgrade_requires_receiver_restart');
}

export function runtimeRelease(dataDir: string, id: string): RuntimeRelease {
  if (!validId(id)) throw Error('live_upgrade_invalid_release');
  const root = join(dataDir, 'releases', id);
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== join(realpathSync(join(dataDir, 'releases')), id)) throw Error('live_upgrade_invalid_release');
  return { id, root, entry: join(root, 'dist/src/cli.js'), worker: join(root, 'dist/src/runner-worker.js'), manifest: join(root, 'release-manifest.json') };
}
export function activeRuntimeId(dataDir: string, hostId: string): string {
  const file = join(dataDir, 'active-runtime.json');
  if (!existsSync(file)) return hostId;
  const saved = readJson(file);
  if (saved.format !== 1 || saved.hostId !== hostId || !validId(saved.id)
    || saved.trial !== undefined && saved.trial !== true || saved.trial === true && !validId(saved.previous)) throw Error('live_upgrade_invalid_pointer');
  if(saved.trial===true)return saved.previous;
  return saved.id;
}
export function confirmLiveTrial(dataDir:string,hostId:string,id:string):boolean {
  const file=join(dataDir,'active-runtime.json');if(!existsSync(file))return false;
  const pointer=readJson(file);
  if(pointer.format!==1||pointer.hostId!==hostId||pointer.id!==id||pointer.trial!==true||!validId(pointer.previous))return false;
  atomicJson(file,{format:1,hostId,id});return true;
}
export async function loadLiveFactory(host: RuntimeRelease, target: RuntimeRelease, options: LiveRuntimeOptions): Promise<RuntimeFactory> {
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL('./release-check.js', import.meta.url)), target.root, target.id],
      { timeout: 60_000, maxBuffer: 1024 }, error => error ? reject(Error('live_upgrade_verification_failed')) : resolve());
  });
  const hostManifest = readJson(host.manifest) as ReleaseManifest, candidate = readJson(target.manifest) as ReleaseManifest;
  assertLiveCompatible(hostManifest, candidate);
  const module = await import(pathToFileURL(join(target.root, 'dist/src/live-runtime.js')).href);
  if (module.liveRuntimeAbi !== 1 || module.schemaVersion !== SCHEMA_VERSION || typeof module.createLiveRuntime !== 'function') throw Error('live_upgrade_incompatible_runtime');
  return () => module.createLiveRuntime(options);
}

export interface UpgradeReceipt { id: string; state: 'succeeded' | 'failed'; releaseId: string; trial?:boolean; error?: string; }
export function watchLiveUpgrades(config: Config, host: RuntimeRelease, currentId: string, runtime: RuntimeHost,
  options: LiveRuntimeOptions, changed: (fields: Record<string, unknown>) => void): () => Promise<void> {
  const requestFile = join(config.dataDir, 'live-upgrade-request.json'), receiptFile = join(config.dataDir, 'live-upgrade-receipt.json');
  const revision = digest(readFileSync(config.file, 'utf8'));
  let pending: Promise<void> | undefined, closed = false,trialUntil=0,loadedUpdates=0;
  const run = async () => {
    if(trialUntil && Date.now()>=trialUntil && runtime.available) {
      confirmLiveTrial(config.dataDir,host.id,currentId);
      trialUntil=0;
    }
    if (!existsSync(requestFile)) {
      const pointerFile=join(config.dataDir,'active-runtime.json');
      if(existsSync(pointerFile)) {const pointer=readJson(pointerFile);
        if(pointer.hostId===host.id&&pointer.trial===true&&pointer.previous===currentId){atomicJson(pointerFile,{format:1,hostId:host.id,id:currentId});changed({trialRecovered:true,releaseId:currentId});}}
      return;
    }
    const request = readJson(requestFile);
    if (typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id)) throw Error('live_upgrade_invalid_request');
    // A crashed CLI may leave the already settled request behind. Never replay it.
    if (existsSync(receiptFile) && readJson(receiptFile).id === request.id) { unlinkSync(requestFile); return; }
    let receipt: UpgradeReceipt;
    try {
      if (request.hostId !== host.id || request.configRevision !== revision || digest(readFileSync(config.file, 'utf8')) !== revision) throw Error('live_upgrade_configuration_changed');
      if (!validId(request.to)) throw Error('live_upgrade_release_changed');
      const pointerFile=join(config.dataDir,'active-runtime.json');
      if(existsSync(pointerFile)) {
        const pointer=readJson(pointerFile);
        if(pointer.hostId===host.id && pointer.trial===true && pointer.previous===currentId && pointer.id===request.to) {
          atomicJson(pointerFile,{format:1,hostId:host.id,id:currentId});
          throw Error('live_upgrade_trial_interrupted');
        }
      }
      // A crash after the durable pointer commit may precede the receipt. Startup
      // has already verified and loaded that pointer, so settle without replay.
      if (request.to === currentId) {
        atomicJson(receiptFile, { id: request.id, state: 'succeeded', releaseId: currentId });
        unlinkSync(requestFile); return;
      }
      if (request.from !== currentId) throw Error('live_upgrade_release_changed');
      if (trialUntil) throw Error('live_upgrade_trial_in_progress');
      if (options.store.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get()) throw Error('live_upgrade_maintenance_busy');
      const target = runtimeRelease(config.dataDir, request.to);
      const factory = await loadLiveFactory(host, target, options);
      loadedUpdates++;changed({liveUpgradeCount:loadedUpdates,restartRecommended:loadedUpdates>=5});
      if (closed) throw Error('live_upgrade_closing');
      if (digest(readFileSync(config.file, 'utf8')) !== revision) throw Error('live_upgrade_configuration_changed');
      if (options.store.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get()) throw Error('live_upgrade_maintenance_busy');
      changed({ upgrading: true });
      await runtime.replace(factory, () => {
        try { atomicJson(join(config.dataDir, 'active-runtime.json'), { format: 1, hostId: host.id, id: target.id,trial:true,previous:currentId }); }
        catch (error) {
          // An error after rename is an ambiguous receipt, not a failed commit.
          const saved=readJson(join(config.dataDir,'active-runtime.json'));
          if(saved.hostId!==host.id||saved.id!==target.id||saved.trial!==true||saved.previous!==currentId)throw error;
        }
      });
      currentId = target.id;
      trialUntil=Date.now()+5*60_000;
      changed({ releaseId: currentId, upgrading: false });
      receipt = { id: request.id, state: 'succeeded', releaseId: currentId,trial:true };
    } catch (error) {
      changed({ upgrading: false, ...(!runtime.available ? { ready: false } : {}) });
      const message = error instanceof Error ? error.message : '';
      receipt = { id: request.id, state: 'failed', releaseId: currentId,
        error: /^live_upgrade_[a-z_]+$/.test(message) ? message : 'live_upgrade_failed' };
    }
    atomicJson(receiptFile, receipt);
    if (existsSync(requestFile) && readJson(requestFile).id === request.id) unlinkSync(requestFile);
  };
  const timer = setInterval(() => {
    if (closed || pending) return;
    pending = run().catch(() => options.log('live_upgrade_control_failed')).finally(() => { pending = undefined; });
  }, 500);
  return async () => { closed = true; clearInterval(timer); await pending; };
}

/** Called under the service-action/config locks. Timeout means unknown, never a
 * reason to stop the receiver or replay the request with another identity. */
export async function requestLiveUpgrade(config: Config, hostId: string, from: string, to: string, timeoutMs = 90_000): Promise<UpgradeReceipt> {
  const requestFile = join(config.dataDir, 'live-upgrade-request.json'), receiptFile = join(config.dataDir, 'live-upgrade-receipt.json');
  if (existsSync(requestFile)) throw Error('live_upgrade_pending_check_status');
  const id = randomUUID();
  atomicJson(requestFile, { id, hostId, from, to, configRevision: digest(readFileSync(config.file, 'utf8')) });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(receiptFile)) {
      const receipt = readJson(receiptFile) as UpgradeReceipt;
      if (receipt.id === id) {
        if (receipt.state !== 'succeeded') throw Error(receipt.error ?? 'live_upgrade_failed');
        return receipt;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('live_upgrade_outcome_unconfirmed_check_status');
}
