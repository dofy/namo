import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ArtifactError, prepareArtifact } from '../src/artifacts.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-artifact-')), project = join(dir, 'project');
  mkdirSync(join(project, 'output'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const request = { taskId: 'N-ONE', ownerId: 'alice', chatId: 'chat', projectRoot: project, projectRelativePath: 'output/report.md' };
  const authorization = { ...request, source: 'task_instruction' as const };
  return { dir, project, request, authorization };
}

function code(fn: () => unknown): string {
  try { fn(); return 'none'; } catch (error) { assert.ok(error instanceof ArtifactError); return error.code; }
}

test('preparation binds task ownership and freezes verified payload and hash', t => {
  const f = fixture(t); writeFileSync(join(f.project, 'output/report.md'), '# result\n');
  const artifact = prepareArtifact(f.request, f.authorization);
  assert.deepEqual(artifact.binding, { taskId: 'N-ONE', ownerId: 'alice', chatId: 'chat' });
  assert.equal(artifact.relativePath, 'output/report.md'); assert.equal(artifact.kind, 'file');
  assert.equal(artifact.mime, 'text/markdown; charset=utf-8');
  assert.equal(artifact.sha256, createHash('sha256').update('# result\n').digest('hex'));
  const first = artifact.readPayload(); first.fill(0);
  assert.equal(artifact.readPayload().toString(), '# result\n');
  writeFileSync(join(f.project, 'output/report.md'), 'changed after preparation');
  assert.equal(artifact.readPayload().toString(), '# result\n');
  assert.equal(Object.isFrozen(artifact), true); assert.equal(Object.isFrozen(artifact.binding), true);
});

test('task, owner, chat, project and exact path authorization must all match', t => {
  const f = fixture(t); writeFileSync(join(f.project, 'output/report.md'), 'ok');
  for (const patch of [{ taskId: 'N-TWO' }, { ownerId: 'bob' }, { chatId: 'other' },
    { projectRoot: join(f.dir, 'other') }, { projectRelativePath: 'output/other.md' }]) {
    assert.equal(code(() => prepareArtifact({ ...f.request, ...patch }, f.authorization)), 'artifact_not_authorized');
  }
  assert.equal(code(() => prepareArtifact(f.request, { ...f.authorization, source: 'material' as any })), 'artifact_not_authorized');
});

test('absolute, traversal, denied, external and symlink paths are rejected', t => {
  const f = fixture(t); writeFileSync(join(f.project, 'output/report.md'), 'ok');
  const outside = join(f.dir, 'outside.md'); writeFileSync(outside, 'outside');
  symlinkSync(outside, join(f.project, 'output/link.md'));
  const attempt = (path: string) => {
    const request = { ...f.request, projectRelativePath: path };
    return code(() => prepareArtifact(request, { ...request, source: 'task_instruction' }));
  };
  assert.equal(attempt(outside), 'invalid_artifact_path');
  assert.equal(attempt('../outside.md'), 'invalid_artifact_path');
  assert.equal(attempt('output/link.md'), 'artifact_symlink_denied');
  for (const path of ['.git/result.md', 'config/result.md', 'data/result.md', 'logs/result.md', 'output/config.local.json', 'output/.env']) {
    assert.equal(attempt(path), 'artifact_path_denied');
  }
  const deepRequest = { ...f.request, projectRelativePath: 'output/report.md' };
  assert.equal(code(() => prepareArtifact(deepRequest, { ...deepRequest, source: 'task_instruction' }, { maxDepth: 1 })), 'invalid_artifact_path');
});

test('unsupported, empty, oversized and signature-mismatched files fail before delivery', t => {
  const f = fixture(t);
  const attempt = (path: string, bytes: string | Buffer, options: any = {}) => {
    writeFileSync(join(f.project, 'output', path), bytes);
    const request = { ...f.request, projectRelativePath: `output/${path}` };
    return code(() => prepareArtifact(request, { ...request, source: 'task_instruction' }, options));
  };
  assert.equal(attempt('run.sh', '#!/bin/sh'), 'artifact_type_unsupported');
  assert.equal(attempt('empty.txt', ''), 'artifact_empty');
  assert.equal(attempt('large.txt', '123456', { maxBytes: 5 }), 'artifact_size_limit');
  assert.equal(attempt('fake.png', 'not png'), 'artifact_type_mismatch');
  assert.equal(attempt('binary.md', Buffer.from([0xc3, 0x28])), 'artifact_type_mismatch');
});

test('supported image and PDF signatures are classified without reading them again at send time', t => {
  const f = fixture(t);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload')]);
  writeFileSync(join(f.project, 'output/image.png'), png);
  const imageRequest = { ...f.request, projectRelativePath: 'output/image.png' };
  const image = prepareArtifact(imageRequest, { ...imageRequest, source: 'task_instruction' });
  assert.equal(image.kind, 'image'); assert.equal(image.mime, 'image/png'); assert.deepEqual(image.readPayload(), png);
  writeFileSync(join(f.project, 'output/report.pdf'), '%PDF-1.7\nfixture');
  const pdfRequest = { ...f.request, projectRelativePath: 'output/report.pdf' };
  const pdf = prepareArtifact(pdfRequest, { ...pdfRequest, source: 'task_instruction' });
  assert.equal(pdf.platformFileType, 'pdf'); assert.equal(pdf.kind, 'file');
});
