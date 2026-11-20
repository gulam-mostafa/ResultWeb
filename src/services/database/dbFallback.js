import { get, onValue, ref, set, update } from 'firebase/database';
import { db } from '../../firebase/firebaseConfig.js';
import { readJSON, writeJSON } from '../storageService.js';

/**
 * Offline / permission-resilient Firebase Realtime Database helpers.
 *
 * Every read and write in `src/services/database/` funnels through this module so:
 *  - a dropped connection (or temporarily-blocked security rules) degrades into a
 *    localStorage cache instead of throwing inside a React render;
 *  - callers always receive `{ synced: boolean }`, which feeds the sync badge;
 *  - nested multi-path patches keep their structure when cached.
 */

const cacheKey = (path) => `resultweb:firebase-cache:${String(path).replaceAll('/', ':')}`;

export const cached = (path, fallback = null) => readJSON(cacheKey(path), fallback);

const cache = (path, value) => {
  try {
    writeJSON(cacheKey(path), value ?? null);
  } catch {
    /* storage unavailable – memory hub still works */
  }
  return value;
};

/** Stable, cheap serialisation used only for change detection. */
function serialise(value) {
  if (value === undefined) return 'u';
  try {
    return JSON.stringify(value) ?? 'u';
  } catch {
    return `o:${Date.now()}`;
  }
}

/** Applies an RTDB multi-path patch (`{ 'a/b/c': value }`) onto a plain object. */
export function applyPatch(base, patch) {
  const root = base && typeof base === 'object' ? structuredCloneSafe(base) : {};
  Object.entries(patch ?? {}).forEach(([key, value]) => {
    const segments = String(key).split('/').filter(Boolean);
    if (segments.length === 0) return;
    let cursor = root;
    segments.slice(0, -1).forEach((segment) => {
      if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = {};
      cursor = cursor[segment];
    });
    const leaf = segments[segments.length - 1];
    if (value === null) delete cursor[leaf];
    else cursor[leaf] = value;
  });
  return root;
}

/** JSON-safe deep clone that also strips `undefined` (Firebase rejects it). */
export function cleanForCloud(value) {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value, (key, item) => (item === undefined ? undefined : item));
    return json === undefined ? undefined : JSON.parse(json);
  } catch {
    return undefined;
  }
}

const structuredCloneSafe = (value) => cleanForCloud(value) ?? {};

export async function safeRead(path, fallback = null) {
  try {
    const snap = await get(ref(db, path));
    const value = snap.exists() ? snap.val() : fallback;
    cache(path, value);
    return value;
  } catch {
    return cached(path, fallback);
  }
}

/** Full replace. Prefer `safeUpdate` when other writers may share the node. */
export async function safeWrite(path, value) {
  const clean = cleanForCloud(value) ?? null;
  cache(path, clean);
  try {
    await set(ref(db, path), clean);
    return { synced: true };
  } catch {
    return { synced: false };
  }
}

/**
 * Non-clobbering merge write. Nested keys (`'a/b'`) are supported, so concurrent
 * teachers editing different students never overwrite one another.
 */
export async function safeUpdate(path, patch) {
  const clean = cleanForCloud(patch) ?? {};
  if (Object.keys(clean).length === 0) return { synced: true };
  cache(path, applyPatch(cached(path, {}), clean));
  try {
    await update(ref(db, path), clean);
    return { synced: true };
  } catch {
    return { synced: false };
  }
}

/** Deletes a node, degrading to a cache-only removal when offline. */
export async function safeRemove(path) {
  try {
    await update(ref(db), { [path]: null });
    cache(path, null);
    return { synced: true };
  } catch {
    return { synced: false };
  }
}

/* ------------------------------------------------------------------ *
 * Single-listener subscription hub  ← prevents the infinite sync loop
 * ------------------------------------------------------------------ */

const hubs = new Map();
let listenerSeq = 0;
const noop = () => {};

function emitStatus(hub, status) {
  if (!status || hub.status === status) return;
  hub.status = status;
  hub.listeners.forEach(({ onStatus }) => {
    try {
      onStatus?.(status);
    } catch {
      /* a status consumer must never break the subscription */
    }
  });
}

function emitValue(hub, value) {
  // Copy first: a callback may unsubscribe synchronously.
  [...hub.listeners.values()].forEach(({ callback }) => {
    try {
      callback?.(value);
    } catch (error) {
      console.error('Realtime listener error:', error);
    }
  });
}

function createHub(path, fallback) {
  const initial = cached(path, fallback ?? null);
  const hub = {
    path,
    fallback: fallback ?? null,
    listeners: new Map(),
    value: initial,
    serial: serialise(initial),
    status: 'unknown',
    off: null,
    teardown: null,
  };

  try {
    hub.off = onValue(
      ref(db, path),
      (snapshot) => {
        const value = snapshot.exists() ? snapshot.val() : hub.fallback;
        const serial = serialise(value);
        const changed = serial !== hub.serial;
        hub.value = value;
        hub.serial = serial;
        cache(path, value);
        emitStatus(hub, 'synced');
        // Only notify real changes – an echo of our own write is absorbed silently.
        // NB: never write to RTDB from inside this listener.
        if (changed) emitValue(hub, value);
      },
      () => {
        emitStatus(hub, 'offline');
      },
    );
  } catch {
    hub.off = null;
  }

  return hub;
}

/**
 * Live subscription with graceful fallback — **one listener per path app-wide**.
 * Delivers the locally cached value immediately (instant paint) and then every real
 * remote change exactly once. Always returns an idempotent unsubscribe function.
 */
export function safeSubscribe(path, callback, fallback = null, onStatus) {
  if (!path || typeof callback !== 'function') {
    if (typeof callback === 'function') callback(fallback);
    return noop;
  }

  let hub = hubs.get(path);
  if (!hub) {
    hub = createHub(path, fallback);
    hubs.set(path, hub);
  }
  if (hub.teardown) {
    clearTimeout(hub.teardown);
    hub.teardown = null;
  }

  const id = (listenerSeq += 1);
  hub.listeners.set(id, {
    callback,
    onStatus: typeof onStatus === 'function' ? onStatus : noop,
  });

  // Instant paint from cache (or fallback) – never waits for the network.
  callback(hub.value !== undefined ? hub.value : fallback);
  if (hub.status !== 'unknown') {
    try {
      onStatus?.(hub.status);
    } catch {
      /* noop */
    }
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = hubs.get(path);
    if (!current) return;
    current.listeners.delete(id);
    if (current.listeners.size > 0) return;
    // Defer teardown one tick so StrictMode's unmount➔remount reuses the socket.
    current.teardown = setTimeout(() => {
      if (current.listeners.size > 0) return;
      try {
        current.off?.();
      } catch {
        /* noop */
      }
      hubs.delete(path);
    }, 0);
  };
}

/** Debug helper: live hub / listener counts (used by the settings diagnostics). */
export function subscriptionStats() {
  let listeners = 0;
  hubs.forEach((hub) => {
    listeners += hub.listeners.size;
  });
  return { paths: hubs.size, listeners };
}

