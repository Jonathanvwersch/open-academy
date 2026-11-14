import { afterEach, expect, test, vi } from 'vitest';
import { readBrowserStorage, writeBrowserStorage } from './browser-storage.js';

afterEach(() => vi.unstubAllGlobals());

test('quota failures use the latest in-memory value instead of stale persisted data', () => {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: () => 'old',
      setItem: () => {
        throw new DOMException('Full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    },
  });
  writeBrowserStorage('localStorage', 'quota', 'new');
  expect(readBrowserStorage('localStorage', 'quota')).toBe('new');
  writeBrowserStorage('localStorage', 'quota', null);
  expect(readBrowserStorage('localStorage', 'quota')).toBeNull();
});

test('blocked storage getters fall back to memory, including removals', () => {
  vi.stubGlobal('window', {
    get localStorage() {
      throw new DOMException('Storage is blocked', 'SecurityError');
    },
  });
  expect(readBrowserStorage('localStorage', 'blocked')).toBeNull();
  writeBrowserStorage('localStorage', 'blocked', 'open');
  expect(readBrowserStorage('localStorage', 'blocked')).toBe('open');
  writeBrowserStorage('localStorage', 'blocked', null);
  expect(readBrowserStorage('localStorage', 'blocked')).toBeNull();
});

test('available storage persists values and keeps session and local keys separate', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal('window', {
    localStorage: storage,
    get sessionStorage() {
      throw new DOMException('Storage is blocked', 'SecurityError');
    },
  });
  writeBrowserStorage('localStorage', 'preference', 'persisted');
  writeBrowserStorage('sessionStorage', 'preference', 'temporary');
  expect(values.get('preference')).toBe('persisted');
  expect(readBrowserStorage('localStorage', 'preference')).toBe('persisted');
  expect(readBrowserStorage('sessionStorage', 'preference')).toBe('temporary');
  writeBrowserStorage('localStorage', 'preference', null);
  expect(values.has('preference')).toBe(false);
  writeBrowserStorage('sessionStorage', 'preference', null);
});
