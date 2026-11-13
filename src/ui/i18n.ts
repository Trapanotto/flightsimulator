import { signal } from '@preact/signals';

export type Lang = 'de' | 'en';

const de = {
  'app.title': 'Trapanotto Flight Simulator',
  'rebuild.badge': 'Neuaufbau',
  'rebuild.title': 'Die Schweiz wird neu gebaut',
  'rebuild.text':
    'Der Simulator entsteht von Grund auf neu: neues Flugverhalten, neue Grafik, neues Menü. Diese Seite zeigt den Zwischenstand – das Fundament läuft, die Welt folgt.',
  'rebuild.hint.mouse': 'Ziehen: Kamera drehen · Mausrad: Abstand',
  'rebuild.hint.touch': 'Wischen: Kamera drehen · Zwei Finger: Abstand',
  'status.renderer': 'Grafik',
  'status.device': 'Gerät',
  'status.device.desktop': 'Desktop',
  'status.device.mobile': 'Mobil',
  'status.fps': 'Bilder/s',
  'status.resolution': 'Auflösung',
  'status.sim': 'Simulation',
  'lang.switch': 'English',
} as const;

export type MessageKey = keyof typeof de;

const en: Record<MessageKey, string> = {
  'app.title': 'Trapanotto Flight Simulator',
  'rebuild.badge': 'Rebuild',
  'rebuild.title': 'Switzerland is being rebuilt',
  'rebuild.text':
    'The simulator is being rebuilt from the ground up: new flight behaviour, new graphics, new menu. This page shows the work in progress – the foundation runs, the world follows.',
  'rebuild.hint.mouse': 'Drag: turn the camera · Wheel: distance',
  'rebuild.hint.touch': 'Swipe: turn the camera · Two fingers: distance',
  'status.renderer': 'Graphics',
  'status.device': 'Device',
  'status.device.desktop': 'Desktop',
  'status.device.mobile': 'Mobile',
  'status.fps': 'Frames/s',
  'status.resolution': 'Resolution',
  'status.sim': 'Simulation',
  'lang.switch': 'Deutsch',
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { de, en };
const KEY = 'tfs.lang';

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    // Storage blocked: fall through to the browser language.
  }
  return typeof navigator !== 'undefined' && navigator.language.startsWith('de') ? 'de' : 'en';
}

/** Current language; components that call t() re-render when it changes. */
export const lang = signal<Lang>(initialLang());

export function setLang(l: Lang) {
  lang.value = l;
  document.documentElement.lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // Not critical.
  }
}

export function t(key: MessageKey): string {
  return MESSAGES[lang.value][key];
}

/** All keys of all languages, for the completeness test. */
export const ALL_MESSAGES = MESSAGES;
