import { NAMO_VERSION } from '../src/version.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { systemLocale, translate } from '../src/i18n.js';
import { t as tr, withLocale } from '../src/locale.js';
import { english } from '../src/locales/en.js';
import { chinese } from '../src/locales/zh-CN.js';

test('system language recognizes browser and POSIX locales with an English fallback', () => {
  assert.equal(systemLocale(['zh-Hans-CN', 'en-US']), 'zh-CN');
  assert.equal(systemLocale(['zh_TW.UTF-8']), 'zh-CN');
  assert.equal(systemLocale(['en_GB.UTF-8']), 'en');
  assert.equal(systemLocale(['C.UTF-8']), 'en');
  assert.equal(systemLocale(['fr-FR']), 'en');
  assert.equal(systemLocale([]), 'en');
});

test('locale dictionaries have the same stable English keys and matching interpolation slots', () => {
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  for (const key of Object.keys(english) as (keyof typeof english)[]) {
    assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, `Invalid message key: ${key}`);
    assert.ok(english[key].trim(), `Empty English translation: ${key}`);
    assert.ok(chinese[key].trim(), `Empty Chinese translation: ${key}`);
    // Language options intentionally use their native names in every locale.
    if (key !== 'assistant.chinese') assert.doesNotMatch(english[key], /[\u3400-\u9fff]/, `Chinese in English translation: ${key}`);
    assert.deepEqual([...chinese[key].matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), [...english[key].matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), key);
    assert.equal(translate('en', key), english[key]);
    assert.equal(translate('zh-CN', key), chinese[key]);
  }
});

test('translations use message IDs and never reinterpret inserted user data', () => {
  assert.equal(translate('en', "cli.workingDirectory", '/project/中文/{1}'), 'Working directory: /project/中文/{1}');
  assert.equal(translate('zh-CN', "cli.workingDirectory", '/project/English'), '工作目录：/project/English');
  // @ts-expect-error Unknown keys are rejected by TypeScript and are safe at runtime.
  assert.equal(translate('en', 'constructor'), 'constructor');
  // @ts-expect-error Chinese copy is not a message ID.
  assert.equal(translate('en', '工作目录：{0}'), '工作目录：{0}');
  assert.equal(translate('zh-CN', 'cli.workingDirectory', 'nav.memoryProfiles'), '工作目录：nav.memoryProfiles');
});

test('simultaneous locale contexts do not change each other or the background chat default', async () => {
  const results = await Promise.all(['en', 'zh-CN'].map(locale => withLocale(locale as 'en' | 'zh-CN', async () => {
    await new Promise(resolve => setTimeout(resolve, locale === 'en' ? 10 : 1));
    return tr("tasks.notFound");
  })));
  assert.deepEqual(results, ['Task not found', '未找到任务']);
  assert.equal(tr("tasks.notFound"), '未找到任务');
});

test('CLI follows system language, supports explicit overrides, and keeps machine output clean', t => {
  const dir = mkdtempSync(join(tmpdir(), 'namo-language-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [resolve('bin/namo.js'), ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NAMO_HOME: dir, NAMO_LANG: 'system', LC_ALL: 'en_US.UTF-8', ...env },
  });
  const en = run(['--help']); assert.equal(en.status, 0); assert.match(en.stdout, /Usage: namo/); assert.match(en.stdout, /https:\/\/github.com\/dofy\/namo/);
  const zh = run(['--help'], { LC_ALL: 'zh_CN.UTF-8' }); assert.equal(zh.status, 0); assert.match(zh.stdout, /用法：namo/);
  assert.match(run(['--lang', 'en', '--help'], { NAMO_LANG: 'zh-CN', LC_ALL: 'zh_CN.UTF-8' }).stdout, /Usage: namo/);
  assert.match(run(['--help'], { NAMO_LANG: 'zh-CN' }).stdout, /用法：namo/);
  assert.match(run(['--help', '--lang', 'system'], { NAMO_LANG: 'zh-CN' }).stdout, /Usage: namo/);
  assert.equal(run(['--lang', 'invalid', '--help']).status, 1);
  assert.equal(run(['--lang', 'en', '--lang', 'zh-CN', '--help']).status, 1);
  assert.equal(run(['--lang']).status, 1);
  assert.equal(run(['--version', '--lang', 'zh-CN']).stdout.trim(), NAMO_VERSION);
  for (const language of ['en', 'zh-CN']) {
    const moved = run(['status', '--lang', language]);
    assert.equal(moved.status, 1);
    assert.match(moved.stderr, language === 'en' ? /workbench/ : /工作台/);
    assert.equal(moved.stdout, '');
    const help = language === 'en' ? en.stdout : zh.stdout;
    assert.match(help, /init.*\n.*login.*\n.*start.*\n.*service.*\n.*ui/s);
    assert.doesNotMatch(help, /agent (list|profiles|probe|use)|Claude|Cursor|doctor|logs\s+|approval request/);
  }
});
