/**
 * Smoke test for the Realtime Database sync hardening.
 *
 * Asserted here:
 *  - the offline queue is DURABLE, ordered and coalescing (no lost / duplicated write);
 *  - a reconnect replays the queue in insertion order, once each;
 *  - `safeMultiPathUpdate()` writes several absolute paths in ONE root-relative
 *    `update()` — which is what makes an admission/promotion atomic;
 *  - `subscribeResults()` does not leak a listener when `unsubscribe()` runs before the
 *    asynchronous year bind resolves (the classic late-bind leak).
 */
import assert from 'node:assert/strict';
import {
  enqueueOffline,
  flushOfflineQueue,
  pendingOfflineCount,
  readOfflineQueue,
  safeMultiPathUpdate,
  subscriptionStats,
} from '../../src/services/database/dbFallback.js';
import { subscribeResults } from '../../src/services/database/resultService.js';
import { rememberSchoolLocation } from '../../src/services/database/dbPaths.js';

const YEAR = '2026';
const BASE = 'divisions/d1/districts/d2/upazilas/u3/schools/s4';
const store = () => {
  globalThis.__smokeStore = globalThis.__smokeStore ?? {};
  return globalThis.__smokeStore;
};
const at = (path) => String(path).split('/').filter(Boolean)
  .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), store());

// A minimal localStorage so the queue survives between calls (as it does in a browser).
if (typeof globalThis.window === 'undefined') {
  const memory = new Map();
  globalThis.window = globalThis;
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => { memory.set(key, String(value)); },
    removeItem: (key) => { memory.delete(key); },
    key: (index) => [...memory.keys()][index] ?? null,
    get length() { return memory.size; },
    clear: () => memory.clear(),
  };
}

/* ------------------------------------------------------------------ *
 * 1. Durable queue: coalescing, ordering, exactly-once replay
 * ------------------------------------------------------------------ */
globalThis.localStorage.clear();
assert.equal(pendingOfflineCount(), 0, 'an empty queue starts at zero');

// Two patches of the SAME node merge into ONE entry (the newest value of a key wins).
enqueueOffline({ op: 'update', path: `${BASE}/students/a`, patch: { 'bangla/term1': 40 } });
enqueueOffline({ op: 'update', path: `${BASE}/students/a`, patch: { 'bangla/term1': 55, 'math/term1': 60 } });
let queue = readOfflineQueue();
assert.equal(queue.length, 1, 'same-path patches are coalesced');
assert.equal(queue[0].patch['bangla/term1'], 55, 'the newest value of a key wins');
assert.equal(queue[0].patch['math/term1'], 60, 'a sibling key is kept');

// A different path is a separate entry, and the order is preserved.
enqueueOffline({ op: 'update', path: `${BASE}/students/b`, patch: { 'bangla/term1': 70 } });
enqueueOffline({ op: 'multipath', entries: { [`${BASE}/studentMaster/STU-1`]: { name: 'রুমি' } } });
queue = readOfflineQueue();
assert.deepEqual(
  queue.map((entry) => entry.op),
  ['update', 'update', 'multipath'],
  'the queue keeps insertion order',
);

// A `set` of a path supersedes every queued patch of that same path.
enqueueOffline({ op: 'set', path: `${BASE}/students/a`, value: { name: 'সম্পূর্ণ প্রতিস্থাপন' } });
queue = readOfflineQueue();
assert.equal(
  queue.filter((entry) => entry.path === `${BASE}/students/a`).length,
  1,
  'a full replace supersedes the queued patches of that node',
);
assert.equal(queue.find((entry) => entry.path === `${BASE}/students/a`).op, 'set');

// The replay applies every entry exactly once, in order.
const replay = await flushOfflineQueue();
assert.equal(replay.synced, true, 'a reconnect replays the queue');
assert.equal(replay.replayed, queue.length, 'every queued entry is replayed once');
assert.equal(pendingOfflineCount(), 0, 'the queue is emptied after a clean replay');
assert.equal(at(`${BASE}/students/a`).name, 'সম্পূর্ণ প্রতিস্থাপন', 'the `set` landed');
assert.equal(at(`${BASE}/students/b`).bangla.term1, 70, 'the patched node is written');
assert.equal(at(`${BASE}/studentMaster/STU-1`).name, 'রুমি', 'the atomic multipath entry landed');

// A second flush is a no-op — no entry is ever applied twice.
const again = await flushOfflineQueue();
assert.equal(again.replayed, 0, 'an already-drained queue replays nothing');

/* ------------------------------------------------------------------ *
 * 2. Atomic multi-path update: several parents in ONE update()
 * ------------------------------------------------------------------ */
globalThis.__smokeStore = {};
const multi = await safeMultiPathUpdate({
  [`${BASE}/studentMaster/STU-2026-001`]: { studentMasterId: 'STU-2026-001', name: 'তানিয়া' },
  [`${BASE}/sessions/${YEAR}/students/class-1/ক/STU-2026-001`]: { roll: 1, section: 'ক' },
  [`schoolData/s4/students/STU-2026-001`]: { id: 'STU-2026-001', name: 'তানিয়া' },
});
assert.equal(multi.synced, true);
assert.equal(multi.paths, 3, 'all three leaves travel in one update');
assert.equal(at(`${BASE}/studentMaster/STU-2026-001`).name, 'তানিয়া');
assert.equal(at(`${BASE}/sessions/${YEAR}/students/class-1/ক/STU-2026-001`).roll, 1);
assert.equal(at('schoolData/s4/students/STU-2026-001').name, 'তানিয়া');

// A `null` leaf in the same update deletes the old node (a move, atomically).
await safeMultiPathUpdate({
  [`${BASE}/sessions/${YEAR}/students/class-1/ক/STU-2026-001`]: { roll: 2, section: 'ক' },
  [`${BASE}/sessions/${YEAR}/students/class-2/ক/STU-2026-001`]: null,
});
assert.equal(at(`${BASE}/sessions/${YEAR}/students/class-2/ক/STU-2026-001`), undefined);

/* ------------------------------------------------------------------ *
 * 3. subscribeResults() must not leak when unsubscribed before the async bind
 * ------------------------------------------------------------------ */
const schoolRef = { divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: 'leak-school' };
rememberSchoolLocation(schoolRef);
const before = subscriptionStats();

// No year ➔ the year listener binds asynchronously via `resolveActiveYear`.
const unsubscribe = subscribeResults(schoolRef, () => {}, undefined);
unsubscribe();
// Give the pending `resolveActiveYear` promise time to settle AFTER the unsubscribe.
await new Promise((resolve) => { setTimeout(resolve, 80); });
const after = subscriptionStats();
assert.equal(
  after.listeners,
  before.listeners,
  'an unsubscribe before the async bind must leave NO listener behind',
);
assert.equal(after.paths, before.paths, 'and no hub may be kept alive for it');

// A normal subscribe/unsubscribe pair is still balanced.
const stop = subscribeResults(schoolRef, () => {}, undefined, YEAR);
await new Promise((resolve) => { setTimeout(resolve, 20); });
assert.ok(subscriptionStats().listeners > before.listeners, 'a live subscription listens');
stop();
await new Promise((resolve) => { setTimeout(resolve, 30); });
assert.equal(subscriptionStats().listeners, before.listeners, 'unsubscribing detaches it again');

console.log('PASS — offline queue replay, atomic multi-path writes, no async-bind listener leak');
