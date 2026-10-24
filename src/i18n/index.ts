import de from './de.json';
import en from './en.json';

export type Lang = 'de' | 'en';
export type MessageKey = keyof typeof de;

export const messages: Record<Lang, Record<MessageKey, string>> = { de, en };

const STORAGE_KEY = 'tfs.lang';

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    // Storage can be blocked (private mode); fall back to the browser language.
  }
  return navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not critical.
  }
}

export function t(lang: Lang, key: MessageKey): string {
  return messages[lang][key];
}
