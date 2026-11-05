import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { prepareArtifact } from './artifacts.js';
import type { GeneratedImage } from './runtime-contract.js';

/** Only paths reported by the current official image-generation event are eligible. */
export function stageGeneratedImage(home: string, cwd: string, threadId: string, runId: string,
  item: { id: string; savedPath: string }): GeneratedImage {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)
    || !item.id || item.id.length > 256) throw Error('generated_image_identity_invalid');
  const root = join(home, 'generated_images', threadId);
  for (const path of [home, join(home, 'generated_images'), root]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('generated_image_directory_invalid');
  }
  const filename = basename(item.savedPath);
  if (resolve(item.savedPath) !== join(resolve(root), filename) || !filename.toLowerCase().endsWith('.png')
    || realpathSync(root) !== join(realpathSync(home), 'generated_images', threadId)) throw Error('generated_image_path_invalid');
  const binding = { taskId: runId, ownerId: runId, chatId: threadId, rootDirectory: root, relativePath: filename };
  const source = prepareArtifact(binding, { ...binding, source: 'task_instruction' });
  const id = createHash('sha256').update(item.id).digest('hex');
  const path = `namo-generated-${runId}-${id.slice(0, 20)}.png`;
  const target = join(cwd, path), payload = source.readPayload();
  if (realpathSync(cwd) !== resolve(cwd) || dirname(target) !== cwd) throw Error('generated_image_workspace_invalid');
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, payload);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.size
      || createHash('sha256').update(readFileSync(target)).digest('hex') !== source.sha256) throw Error('generated_image_conflict');
  } finally { if (fd !== undefined) closeSync(fd); }
  return { id, path, sha256: source.sha256, size: source.size };
}
