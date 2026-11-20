/**
 * Safe localStorage adapter.
 *
 * Every read/write goes through this module so that:
 *  - private-mode / quota / disabled-storage browsers never crash the app;
 *  - a future backend swap only touches this file;
 *  - JSON (de)serialisation and schema versioning live in one place.
 */

const memoryFallback = new Map();

const hasLocalStorage = () => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const probeKey = '__resultweb_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
};

export const storageAvailable = hasLocalStorage();

/** Reads and parses a stored value, returning `fallback` on any failure. */
export function readJSON(key, fallback = null) {
  try {
    const raw = storageAvailable ? window.localStorage.getItem(key) : memoryFallback.get(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Serialises and stores a value. Returns true when the write succeeded. */
export function writeJSON(key, value) {
  try {
    const serialised = JSON.stringify(value);
    if (storageAvailable) {
      window.localStorage.setItem(key, serialised);
    } else {
      memoryFallback.set(key, serialised);
    }
    return true;
  } catch {
    return false;
  }
}

/** Removes a single key. */
export function removeKey(key) {
  try {
    if (storageAvailable) {
      window.localStorage.removeItem(key);
    } else {
      memoryFallback.delete(key);
    }
    return true;
  } catch {
    return false;
  }
}

/** Clears every key owned by this application (prefix-scoped, never global). */
export function clearAppKeys(prefix = 'resultweb:') {
  try {
    if (!storageAvailable) {
      [...memoryFallback.keys()]
        .filter((key) => key.startsWith(prefix))
        .forEach((key) => memoryFallback.delete(key));
      return true;
    }
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
    return true;
  } catch {
    return false;
  }
}

/** Rough storage footprint in bytes – surfaced in the settings screen. */
export function estimateUsage(key) {
  try {
    const raw = storageAvailable ? window.localStorage.getItem(key) : memoryFallback.get(key);
    return raw ? new Blob([raw]).size : 0;
  } catch {
    return 0;
  }
}

export default { readJSON, writeJSON, removeKey, clearAppKeys, estimateUsage, storageAvailable };
