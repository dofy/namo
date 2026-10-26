/** Trusted service launcher: built-ins only until the complete pinned release is verified. */
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function boot(): Promise<void> {
  const [root, expectedId, config] = process.argv.slice(2);
  if (process.argv.length !== 5 || !root || !config || !/^[a-f0-9]{64}$/.test(expectedId ?? '')) throw Error('arguments');
  const resolved = realpathSync(root);
  if (basename(resolved) !== expectedId) throw Error('root');
  const manifestFile = join(root, 'release-manifest.json');
  if (!lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink()) throw Error('manifest');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const { id, ...body } = manifest;
  if (id !== expectedId || hash(JSON.stringify(body)) !== id || manifest.format !== 1
    || manifest.entry !== 'dist/src/cli.js' || manifest.worker !== 'dist/src/runner-worker.js'
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.runtimeDependencies)) throw Error('identity');
  const files: { path: string; bytes: number; mode: number; sha256: string }[] = [];
  const scan = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name), rel = relative(root, file).split(sep).join('/');
      if (rel === 'release-manifest.json') continue;
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('symlink');
      if (stat.isDirectory()) scan(file);
      else if (stat.isFile()) files.push({ path: rel, bytes: stat.size, mode: stat.mode & 0o777, sha256: hash(readFileSync(file)) });
      else throw Error('file-type');
    }
  };
  scan(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)
    || !files.some(file => file.path === manifest.entry) || !files.some(file => file.path === manifest.worker)) throw Error('files');
  const entry = join(root, manifest.entry);
  process.argv = [process.execPath, entry, 'start', '--config', config];
  await import(pathToFileURL(entry).href);
}
void boot().catch(() => {
  // Never echo configuration paths, source text, or raw module errors.
  process.stderr.write('Namo 发布校验或启动失败；服务未绕过版本校验。请用 service status 核对发布。\n');
  process.exitCode = 1;
});
