import { onDisconnect, ref, serverTimestamp, set, update } from 'firebase/database';
import { db } from '../../firebase/firebaseConfig.js';
import { safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import { dbPaths } from './dbPaths.js';

/**
 * userAndVisitorService — profile persistence + silent visitor analytics.
 * Both are best-effort: every failure is swallowed so analytics can never break
 * the sign-in flow.
 */

/** Creates or merges the profile at `users/{uid}`. */
export async function saveUserProfile(uid, profile) {
  if (!uid) return { synced: false };
  return safeUpdate(dbPaths.user(uid), {
    ...profile,
    uid,
    updatedAt: new Date().toISOString(),
  });
}

export function readUserProfile(uid) {
  if (!uid) return Promise.resolve(null);
  return safeRead(dbPaths.user(uid), null);
}

/** Live profile subscription (role/school changes sync across devices). */
export function subscribeUserProfile(uid, callback, onStatus) {
  if (!uid) {
    callback(null);
    return () => {};
  }
  return safeSubscribe(dbPaths.user(uid), (value) => callback(value ?? null), null, onStatus);
}

/** Marks the profile as signed in (and clears it on sign-out). */
export function touchUserStatus(uid, status = 'online') {
  if (!uid) return Promise.resolve({ synced: false });
  return safeUpdate(dbPaths.user(uid), {
    status,
    lastSeenAt: new Date().toISOString(),
  });
}

/** Best-effort device fingerprint used by the visitor log. */
function describeDevice() {
  if (typeof navigator === 'undefined') {
    return { deviceModel: 'Unknown', os: 'Unknown', screenResolution: '—', locale: 'bn', referrer: 'direct' };
  }
  const ua = navigator.userAgent || '';
  const os = /Windows NT/i.test(ua)
    ? 'Windows'
    : /Mac OS X/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Other';

  const deviceModelMatch = ua.match(/\(([^)]+)\)/);
  const deviceModel = /Android|iPhone|iPad|Mobile/i.test(ua)
    ? (deviceModelMatch?.[1] ?? 'Mobile device').split(';').pop().trim()
    : 'Desktop / Laptop';

  const width = typeof window !== 'undefined' ? window.screen?.width ?? window.innerWidth : 0;
  const height = typeof window !== 'undefined' ? window.screen?.height ?? window.innerHeight : 0;

  return {
    deviceModel,
    os,
    screenResolution: width && height ? `${width}x${height}` : '—',
    locale: navigator.language || 'bn-BD',
    referrer: typeof document !== 'undefined' ? document.referrer || 'direct' : 'direct',
    timezone: Intl?.DateTimeFormat?.().resolvedOptions?.().timezone ?? 'Asia/Dhaka',
  };
}

const VISITOR_SESSION_KEY = 'resultweb:visitor-session:v1';

/**
 * Logs a visitor session and keeps `stayDurationSeconds` live.
 * Returns an unsubscribe function that flushes the final duration on unmount.
 */
export function logVisitor({ uid = 'anonymous', role = 'guest', schoolId = null } = {}) {
  if (typeof window === 'undefined') return () => {};

  const startedAt = Date.now();
  const visitorId = `${uid}-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const device = describeDevice();
  const base = {
    visitorId,
    uid,
    role,
    schoolId,
    ...device,
    userAgent: typeof navigator !== 'undefined' ? String(navigator.userAgent).slice(0, 220) : '',
    startedAt: new Date().toISOString(),
    stayDurationSeconds: 0,
  };

  const path = dbPaths.visitor(visitorId);

  const write = async () => {
    const payload = { ...base, stayDurationSeconds: Math.round((Date.now() - startedAt) / 1000) };
    try {
      if (typeof ref === 'function') {
        await set(ref(db, path), { ...payload, startedAtServer: serverTimestamp() });
      }
    } catch {
      await safeUpdate(path, payload);
    }
  };

  write().catch(() => {});

  const ticker = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    try {
      update(ref(db, path), { stayDurationSeconds: seconds }).catch(() => {});
    } catch {
      /* offline: the next online write will carry the final value */
    }
  }, 15000);

  try {
    onDisconnect(ref(db, path)).update({
      offlineAt: new Date().toISOString(),
      endedAt: serverTimestamp(),
    });
  } catch {
    /* noop */
  }

  const stop = () => {
    clearInterval(ticker);
    const payload = {
      ...base,
      stayDurationSeconds: Math.round((Date.now() - startedAt) / 1000),
      endedAt: new Date().toISOString(),
    };
    try {
      update(ref(db, path), payload).catch(() => {});
    } catch {
      /* noop */
    }
    try {
      window.localStorage.setItem(VISITOR_SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* storage disabled */
    }
  };

  window.addEventListener('pagehide', stop, { once: true });
  return stop;
}

export default {
  saveUserProfile,
  readUserProfile,
  subscribeUserProfile,
  touchUserStatus,
  logVisitor,
};

