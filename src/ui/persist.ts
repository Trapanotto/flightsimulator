import { effect } from '@preact/signals';
import { settings } from './api';

/** The part of `Storage` the interface uses; tests pass a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SETTINGS_KEY = 'tfs.settings';

export interface SettingsValues {
  quality: 'auto' | 'low' | 'medium' | 'high';
  volume: number;
  muted: boolean;
  invertPitch: boolean;
  tiltSteering: boolean;
  units: 'metric' | 'aviation';
}

export const DEFAULT_SETTINGS: Readonly<SettingsValues> = {
  quality: 'auto',
  volume: 0.7,
  muted: false,
  invertPitch: false,
  tiltSteering: false,
  units: 'aviation',
};

const QUALITIES = ['auto', 'low', 'medium', 'high'] as const;
const UNITS = ['metric', 'aviation'] as const;

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Reads stored settings field by field: a field that is missing, of the wrong type or out of
 * range falls back to its default, so one bad value (or an older format) never loses the rest.
 */
export function parseSettings(raw: string | null): SettingsValues {
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const o =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const d = DEFAULT_SETTINGS;
  const volume =
    typeof o.volume === 'number' && Number.isFinite(o.volume)
      ? Math.min(1, Math.max(0, o.volume))
      : d.volume;
  return {
    quality: oneOf(o.quality, QUALITIES, d.quality),
    volume,
    muted: bool(o.muted, d.muted),
    invertPitch: bool(o.invertPitch, d.invertPitch),
    tiltSteering: bool(o.tiltSteering, d.tiltSteering),
    units: oneOf(o.units, UNITS, d.units),
  };
}

export function currentSettings(): SettingsValues {
  return {
    quality: settings.quality.value,
    volume: settings.volume.value,
    muted: settings.muted.value,
    invertPitch: settings.invertPitch.value,
    tiltSteering: settings.tiltSteering.value,
    units: settings.units.value,
  };
}

export function applySettings(v: SettingsValues) {
  settings.quality.value = v.quality;
  settings.volume.value = v.volume;
  settings.muted.value = v.muted;
  settings.invertPitch.value = v.invertPitch;
  settings.tiltSteering.value = v.tiltSteering;
  settings.units.value = v.units;
}

function safeGet(storage: StorageLike | undefined, key: string): string | null {
  try {
    return storage ? storage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike | undefined, key: string, value: string) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private mode or a full quota: the setting still holds for this session.
  }
}

export function loadSettings(storage: StorageLike | undefined) {
  applySettings(parseSettings(safeGet(storage, SETTINGS_KEY)));
}

export function saveSettings(storage: StorageLike | undefined) {
  safeSet(storage, SETTINGS_KEY, JSON.stringify(currentSettings()));
}

/** Loads the stored settings and keeps saving every change. Returns the unsubscribe. */
export function persistSettings(storage: StorageLike | undefined): () => void {
  loadSettings(storage);
  let first = true;
  return effect(() => {
    const values = currentSettings();
    // The first run only subscribes: writing back what was just read would be wasted.
    if (first) {
      first = false;
      return;
    }
    safeSet(storage, SETTINGS_KEY, JSON.stringify(values));
  });
}

/** Read and write a small JSON value with the same tolerance (the last flight setup). */
export function readJson(storage: StorageLike | undefined, key: string): unknown {
  const raw = safeGet(storage, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeJson(storage: StorageLike | undefined, key: string, value: unknown) {
  safeSet(storage, key, JSON.stringify(value));
}

/** localStorage when the browser allows it; undefined in Node or with storage blocked. */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
