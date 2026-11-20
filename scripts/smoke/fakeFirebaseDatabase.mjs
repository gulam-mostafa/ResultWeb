/**
 * Minimal in-memory `firebase/database` stub for the promotion smoke test.
 * Reads/writes go to `globalThis.__smokeStore` so the test can inspect the tree.
 */
const store = () => {
  globalThis.__smokeStore = globalThis.__smokeStore ?? {};
  return globalThis.__smokeStore;
};

const segments = (path) => String(path ?? '').split('/').filter(Boolean);

const read = (path) => segments(path)
  .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), store());

const clean = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

const write = (path, value) => {
  const keys = segments(path);
  if (keys.length === 0) {
    globalThis.__smokeStore = value ?? {};
    return;
  }
  let cursor = store();
  keys.slice(0, -1).forEach((key) => {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  });
  const leaf = keys[keys.length - 1];
  if (value === null || value === undefined) delete cursor[leaf];
  else cursor[leaf] = clean(value);
};

/** RTDB multi-path update: every key is a relative path inside `path`. */
const applyPatch = (base, patch) => {
  Object.entries(patch ?? {}).forEach(([key, value]) => {
    write(`${base}/${key}`, value);
  });
};

export function ref(_db, path) {
  return { path: String(path ?? '') };
}

export function getDatabase() {
  return { name: 'smoke-db' };
}

export async function get(target) {
  const value = read(target.path);
  return { exists: () => value !== undefined && value !== null, val: () => clean(value) };
}

export async function set(target, value) {
  write(target.path, value);
}

export async function update(target, patch) {
  // A real RTDB interprets `null` leaves as deletes; mirror that here.
  applyPatch(target.path, patch);
}

export function onValue(target, callback) {
  callback({ exists: () => read(target.path) !== undefined, val: () => clean(read(target.path)) });
  return () => {};
}

export function off() {}

export function query(value) {
  return value;
}

export function orderByChild() {
  return {};
}

export function limitToLast() {
  return {};
}

export function runTransaction(target, handler) {
  const next = handler(read(target.path) ?? null);
  write(target.path, next);
  return Promise.resolve({ committed: true, snapshot: { val: () => read(target.path) } });
}

/** Presence helpers — the hook does not use them, but sibling services import them. */
export function onDisconnect(target) {
  return {
    set: (value) => Promise.resolve(write(target.path, value)),
    remove: () => Promise.resolve(write(target.path, null)),
    cancel: () => Promise.resolve(),
  };
}

export function serverTimestamp() {
  return new Date().toISOString();
}

export default {
  ref, get, set, update, onValue, off, query, orderByChild, limitToLast, runTransaction,
  onDisconnect, serverTimestamp,
};
