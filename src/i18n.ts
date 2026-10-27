import { english, type MessageKey } from './locales/en.js';
import { chinese } from './locales/zh-CN.js';

export type { MessageKey } from './locales/en.js';

export type Locale = 'en' | 'zh-CN';
export type LanguagePreference = Locale | 'system';
export function parseLocale(value: string | undefined): Locale | undefined {
  const language = value?.trim().toLowerCase();
  if (language === 'en' || language === 'en-us' || language === 'en-gb') return 'en';
  if (language === 'zh' || language === 'zh-cn' || language === 'zh-hans') return 'zh-CN';
  return undefined;
}

export function systemLocale(languages: readonly (string | undefined)[]): Locale {
  for (const language of languages) {
    const base = language?.trim().toLowerCase().split(/[_.@-]/)[0];
    if (base === 'zh') return 'zh-CN';
    if (base === 'en' || base === 'c' || base === 'posix') return 'en';
  }
  return 'en';
}

/** Translate application messages only. User input and execution output are never passed here. */
export function translate(locale: Locale, key: MessageKey, ...values: unknown[]): string {
  const messages = locale === 'zh-CN' ? chinese : english;
  const template = Object.hasOwn(messages, key) ? messages[key] : key;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
