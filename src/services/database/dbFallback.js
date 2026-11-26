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
    enqueueOffline({ op: 'set', path, value: clean });
    return { synced: false };
  }
}

/**
 * Non-clobbering merge write. Nested keys (`'a/b'`) are supported, so concurrent
 * teachers editing different students never overwrite one another.
 *
 * A failed write is remembered in the durable offline queue and replayed in order on
 * reconnect (see `flushOfflineQueue`), so an offline edit is never silently lost.
 */
export async function safeUpdate(path, patch) {
  const clean = cleanForCloud(patch) ?? {};
  if (Object.keys(clean).length === 0) return { synced: true };
  cache(path, applyPatch(cached(path, {}), clean));
  try {
    await update(ref(db, path), clean);
    return { synced: true };
  } catch {
    enqueueOffline({ op: 'update', path, patch: clean });
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
    enqueueOffline({ op: 'remove', path });
    return { synced: false };
  }
}

/* ------------------------------------------------------------------ *
 * Atomic multi-path writes (একাধিক নোড একসাথে)
 * ------------------------------------------------------------------ */

/**
 * Atomically writes several ABSOLUTE paths in one RTDB `update()`.
 *
 * A root-level multi-path `update()` is the only way to change nodes that live under
 * different parents (`studentMaster/{id}` **and** `sessions/{year}/students/…`) as ONE
 * operation: either every leaf lands or none does, so a reader can never observe a
 * pupil written to the year partition but missing from `studentMaster`.
 *
 * @param {object} entries `{ 'divisions/…/studentMaster/STU-1': row, '…/students/…': row2 }`
 * @returns {Promise<{synced:boolean, paths:number}>}
 */
export async function safeMultiPathUpdate(entries) {
  const clean = Object.fromEntries(
    Object.entries(entries ?? {}).filter(([path, value]) => (
      typeof path === 'string' && path.trim() !== '' && value !== undefined
    )),
  );
  const paths = Object.keys(clean);
  if (!paths.length) return { synced: true, paths: 0 };
  const payload = cleanForCloud(clean) ?? {};
  // Cache each touched subtree so an offline reader still sees the new state.
  Object.entries(payload).forEach(([path, value]) => {
    const segments = path.split('/').filter(Boolean);
    const parent = segments.slice(0, -1).join('/');
    if (!parent) return;
    cache(parent, applyPatch(cached(parent, {}), { [segments[segments.length - 1]]: value }));
  });
  try {
    await update(ref(db), payload);
    return { synced: true, paths: paths.length };
  } catch {
    // A failed atomic write is queued as ONE unit, so a replay can never leave a
    // half-written multi-node change behind.
    enqueueOffline({ op: 'multipath', entries: payload });
    return { synced: false, paths: paths.length };
  }
}


/* ------------------------------------------------------------------ *
 * Offline write queue — durable, ordered, duplicate-free replay
 * ------------------------------------------------------------------ */

const QUEUE_KEY = 'resultweb:offline-queue:v1';

/** `true` while the browser reports no connection. */
const browserOffline = () => {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
};

/** Current queue (`[]` when storage is unavailable). */
export function readOfflineQueue() {
  const stored = readJSON(QUEUE_KEY, []);
  return Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.op === 'string') : [];
}

const writeOfflineQueue = (queue) => {
  writeJSON(QUEUE_KEY, Array.isArray(queue) ? queue : []);
  return queue;
};

/** How many writes are still waiting for a connection (feeds the sync badge). */
export const pendingOfflineCount = () => readOfflineQueue().length;

/**
 * Appends one failed write to the durable queue.
 *
 * Coalescing rules (they are what guarantee "no lost update, no duplicate"):
 *  - two `update` patches of the SAME path merge into one entry (the newest value of a
 *    key wins), so typing 40 cells offline replays as one write per node;
 *  - a `set`/`remove` of a path REPLACES every queued `update` of that path;
 *  - a `multipath` entry stays an indivisible unit.
 *
 * @returns {Array<object>} the queue after the insert
 */
export function enqueueOffline(entry) {
  if (!entry || !entry.op) return readOfflineQueue();
  const queue = readOfflineQueue();
  const next = { at: new Date().toISOString(), ...entry };

  if (next.op === 'update' && next.path) {
    const index = queue.findIndex((item) => item.op === 'update' && item.path === next.path);
    if (index >= 0) {
      queue[index] = {
        ...queue[index],
        patch: { ...(queue[index].patch ?? {}), ...(next.patch ?? {}) },
        at: next.at,
      };
      return writeOfflineQueue(queue);
    }
    return writeOfflineQueue([...queue, next]);
  }

  if ((next.op === 'set' || next.op === 'remove') && next.path) {
    // A full replace/delete supersedes every queued patch of that same path.
    const filtered = queue.filter((item) => !(item.path === next.path && item.op === 'update'));
    return writeOfflineQueue([...filtered, next]);
  }

  return writeOfflineQueue([...queue, next]);
}

/** Removing exactly one entry (by content) — a coalesced sibling is never lost. */
const withoutEntry = (entry) => {
  const queue = readOfflineQueue();
  const wanted = `${entry.op}|${entry.path ?? ''}|${entry.at ?? ''}`;
  const index = queue.findIndex((item) => `${item.op}|${item.path ?? ''}|${item.at ?? ''}` === wanted);
  if (index < 0) return queue;
  return writeOfflineQueue([...queue.slice(0, index), ...queue.slice(index + 1)]);
};

let flushPromise = null;

/**
 * Replays the offline queue **in insertion order**.
 *
 * - One entry at a time: a failing entry stops the replay, so a later write can never
 *   overtake an earlier one (that is what used to resurrect a stale value on reconnect).
 * - Each successful entry is dropped immediately, so a crash mid-replay resumes exactly
 *   where it stopped — an entry is never applied twice.
 * - Concurrent callers share ONE replay (`flushPromise`), so the `online` event and a
 *   successful save can never duplicate the same patch.
 *
 * @returns {Promise<{synced:boolean, replayed:number, pending:number}>}
 */
export function flushOfflineQueue() {
  if (flushPromise) return flushPromise;
  const queue = readOfflineQueue();
  if (queue.length === 0) return Promise.resolve({ synced: true, replayed: 0, pending: 0 });
  if (browserOffline()) return Promise.resolve({ synced: false, replayed: 0, pending: queue.length });

  flushPromise = (async () => {
    let replayed = 0;
    // A snapshot copy is replayed; writes that arrive meanwhile stay queued behind it.
    for (let index = 0; index < queue.length; index += 1) {
      const entry = queue[index];
      try {
        if (entry.op === 'multipath') {
          await update(ref(db), cleanForCloud(entry.entries) ?? {});
        } else if (entry.op === 'update') {
          await update(ref(db, entry.path), cleanForCloud(entry.patch) ?? {});
        } else if (entry.op === 'set') {
          await set(ref(db, entry.path), cleanForCloud(entry.value) ?? null);
        } else if (entry.op === 'remove') {
          await update(ref(db), { [entry.path]: null });
        }
      } catch {
        // Keep THIS entry and everything after it: the order must survive a retry.
        return { synced: false, replayed, pending: readOfflineQueue().length };
      }
      replayed += 1;
      withoutEntry(entry);
    }
    return { synced: true, replayed, pending: readOfflineQueue().length };
  })()
    .catch(() => ({ synced: false, replayed: 0, pending: readOfflineQueue().length }))
    .finally(() => { flushPromise = null; });

  return flushPromise;
}

/**
 * Starts the automatic replay on reconnect (idempotent; browser only).
 * A page that loads while already online also drains any queue left by the last session.
 */
export function installOfflineQueueAutoFlush() {
  if (typeof window === 'undefined' || window.__resultwebOfflineQueue === true) return () => {};
  window.__resultwebOfflineQueue = true;
  const handleOnline = () => { flushOfflineQueue(); };
  window.addEventListener('online', handleOnline);
  if (!browserOffline()) setTimeout(handleOnline, 0);
  return () => window.removeEventListener('online', handleOnline);
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

