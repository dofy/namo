import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemePreference, resolveThemePreference } from '../src/theme-contract.js';

test('theme defaults to auto, follows the system and preserves explicit choices',()=>{
 assert.equal(parseThemePreference(undefined),'auto');assert.equal(parseThemePreference('invalid'),'auto');
 assert.equal(resolveThemePreference('auto',false),'light');assert.equal(resolveThemePreference('auto',true),'dark');
 assert.equal(resolveThemePreference(parseThemePreference('light'),true),'light');
 assert.equal(resolveThemePreference(parseThemePreference('dark'),false),'dark');
});
