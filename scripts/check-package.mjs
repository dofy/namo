import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'namo-package-'));
function run(command,args) {
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(result.status,0,`${command} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout;
}
try {
  const tarball=join(temp,'namo.tgz');
  run('pnpm',['pack','--out',tarball]);
  const files=run('tar',['-tzf',tarball]).trim().split('\n').filter(name=>!name.endsWith('/'));
  const allowed=[
    /^package\/(package\.json|README(?:\.zh-CN)?\.md|LICENSE(?:\.md|\.txt)?|config\.example\.json|bin\/namo\.js)$/,
    /^package\/docs\/(?:README|[a-z-]+)\.md$/,
    /^package\/assets\/(namo-logo\.png|fonts\/[A-Za-z0-9._-]+\.(md|txt|woff2?|ttf))$/,
    /^package\/dist\/(src|scripts)\/[A-Za-z0-9_./-]+\.js(?:\.map)?$/,
    /^package\/dist\/ui\/(index\.html|assets\/[A-Za-z0-9._-]+\.(js|css|png|svg|woff2?|ttf))$/,
  ];
  assert.ok(files.length>0,'Package is empty');
  for(const file of files) {
    assert.ok(!file.split('/').includes('..')&&allowed.some(pattern=>pattern.test(file)),`Unexpected packaged file: ${file}`);
  }
  for(const required of ['package.json','bin/namo.js','dist/src/cli.js','dist/src/runner-worker.js','dist/src/service-bootstrap.js',
    'dist/scripts/smoke-codex.js','dist/ui/index.html','config.example.json','assets/namo-logo.png']) {
    assert.ok(files.includes('package/'+required),`Missing runtime file: ${required}`);
  }
  const manifest=JSON.parse(run('tar',['-xOf',tarball,'package/package.json']));
  const source=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(manifest.name,source.name); assert.equal(manifest.version,source.version);
  assert.deepEqual(manifest.dependencies,source.dependencies); assert.equal(manifest.bin.namo,'bin/namo.js');
  const html=run('tar',['-xOf',tarball,'package/dist/ui/index.html']);
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match=>match[1]);
  assert.ok(assets.length>0,'UI has no bundled assets');
  for(const asset of assets)assert.ok(files.includes('package/dist/ui'+asset),`Missing UI asset: ${asset}`);
  console.log(`Package verified: ${files.length} files, ${assets.length} UI assets; no local config, data, credentials or tests.`);
} finally { rmSync(temp,{recursive:true,force:true}); }
