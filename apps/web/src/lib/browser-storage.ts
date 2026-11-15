type StorageKind = 'localStorage' | 'sessionStorage';

const fallback = new Map<string, string>();
const failedWrites = new Set<string>();

/** Browser storage is optional: privacy settings and storage limits must not block learning. */
export function readBrowserStorage(kind: StorageKind, key: string): string | null {
  const fallbackKey = `${kind}:${key}`;
  if (failedWrites.has(fallbackKey)) return fallback.get(fallbackKey) ?? null;
  try {
    return window[kind].getItem(key);
  } catch {
    return fallback.get(fallbackKey) ?? null;
  }
}

export function writeBrowserStorage(kind: StorageKind, key: string, value: string | null) {
  const fallbackKey = `${kind}:${key}`;
  if (value === null) fallback.delete(fallbackKey);
  else fallback.set(fallbackKey, value);
  try {
    if (value === null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
    failedWrites.delete(fallbackKey);
  } catch {
    failedWrites.add(fallbackKey);
    // Keep the preference in memory for this page when persistence is unavailable.
  }
}
