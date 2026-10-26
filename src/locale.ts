import { AsyncLocalStorage } from 'node:async_hooks';
import { translate, type Locale } from './i18n.js';

const locales = new AsyncLocalStorage<Locale>();
// Background/chat execution keeps its existing language. CLI and HTTP requests
// explicitly select a locale without sharing mutable language state.
export const currentLocale = (): Locale => locales.getStore() ?? 'zh-CN';
export const withLocale = <T>(locale: Locale, run: () => T): T => locales.run(locale, run);
export const t = (key: string, ...values: unknown[]): string => translate(currentLocale(), key, ...values);
