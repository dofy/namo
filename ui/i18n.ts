import { useSyncExternalStore } from 'react';
import { parseLocale, systemLocale, translate, type LanguagePreference, type Locale } from '../src/i18n';

const preference = 'namo_ui_language';
function readPreference(): LanguagePreference {
  try { return parseLocale(document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${preference}=`))?.slice(preference.length + 1)) ?? 'system'; }
  catch { return 'system'; }
}
let selected = readPreference();
let locale = selected === 'system' ? systemLocale(navigator.languages) : selected;
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export function setLocale(next: LanguagePreference) {
  if (selected === next) return;
  selected = next;
  locale = next === 'system' ? systemLocale(navigator.languages) : next;
  // This non-sensitive preference spans the workbench's random loopback ports.
  // Authentication remains in its separate, port-scoped HttpOnly cookie.
  try { document.cookie = `${preference}=${next}; Path=/; Max-Age=31536000; SameSite=Strict`; } catch { /* Session-only preference when cookies are unavailable. */ }
  document.documentElement.lang = locale;
  for (const notify of listeners) notify();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useLocale = () => useSyncExternalStore(subscribe, getLocale, () => 'en' as Locale);
export const useLanguagePreference = () => useSyncExternalStore(subscribe, () => selected, () => 'system' as LanguagePreference);
export const t = (key: string, ...values: unknown[]): string => translate(locale, key, ...values);
document.documentElement.lang = locale;
window.addEventListener('languagechange', () => {
  if (selected !== 'system') return;
  locale = systemLocale(navigator.languages);
  document.documentElement.lang = locale;
  for (const notify of listeners) notify();
});
