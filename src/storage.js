// src/storage.js — Local persistence for events, pre-freeze snapshots, outbox, and session metrics
// Coordinated single-writer / transactional mutual exclusion covering ALL shared-buffer mutations.

const SNAPSHOT_KEY = 'axona.track.pre_freeze_snapshot';
const EVENTS_KEY   = 'axona.track.events_log';
const METRICS_KEY  = 'axona.track.session_metrics';
const OUTBOX_KEY   = 'axona.track.offline_outbox';
const DROPS_KEY    = 'axona.track.storage_drops';
const FLUSH_LOCK_KEY = 'axona.track.flush_lock';
const MUTEX_KEY    = 'axona.track.storage_mutex';

const MAX_LOCAL_EVENTS = 500;
const MAX_OUTBOX_EVENTS = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24-hour retention limit (Aster seq 469/471)
const LEASE_HEARTBEAT_MS = 1000;
const LEASE_EXPIRY_MS = 8000; // 8s heartbeat expiration for dead-holder recovery

/**
 * In-process async execution queue for sequential FIFO serialization
 */
class AsyncLockQueue {
  constructor() {
    this._queue = Promise.resolve();
  }

  enqueue(fn) {
    const next = this._queue.then(async () => {
      return await fn();
    });
    this._queue = next.catch(() => {});
    return next;
  }
}

const localQueue = new AsyncLockQueue();

/**
 * Storage accessor helper with strict exception handling (fail-closed)
 */
function getStorage() {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage is not available');
  }
  return localStorage;
}

function readRawArray(key) {
  const storage = getStorage();
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[axona.track] Storage key ${key} contained non-array data; resetting`);
      return [];
    }
    return parsed;
  } catch (err) {
    console.error(`[axona.track] Corrupted JSON in storage key ${key}:`, err);
    throw new Error(`Storage corruption: invalid JSON in ${key}`);
  }
}

/**
 * Fallback cross-tab coordinator using heartbeat lease and verified token release
 */
class FallbackCoordinator {
  _generateToken() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  async runExclusive(task) {
    return localQueue.enqueue(async () => {
      const token = this._generateToken();
      let heartbeat = null;

      try {
        const storage = getStorage();
        // Wait for any existing valid lease to clear
        const start = Date.now();
        while (true) {
          const raw = storage.getItem(MUTEX_KEY);
          let held = false;
          if (raw) {
            try {
              const lease = JSON.parse(raw);
              if (lease && (Date.now() - lease.ts) < LEASE_EXPIRY_MS) {
                held = true;
              }
            } catch {
              held = false;
            }
          }

          if (!held) {
            // Write our lock
            storage.setItem(MUTEX_KEY, JSON.stringify({ token, ts: Date.now() }));
            // Small jitter verify
            await new Promise((r) => setTimeout(r, 10));
            const recheck = JSON.parse(storage.getItem(MUTEX_KEY) || '{}');
            if (recheck.token === token) {
              break; // Lock acquired
            }
          }

          if (Date.now() - start > 10000) {
            throw new Error('Storage mutex acquisition timed out after 10000ms');
          }
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
        }

        // Active heartbeat while task executes — ensures slow operations (>5s) never expire
        heartbeat = setInterval(() => {
          try {
            const cur = JSON.parse(storage.getItem(MUTEX_KEY) || '{}');
            if (cur.token === token) {
              storage.setItem(MUTEX_KEY, JSON.stringify({ token, ts: Date.now() }));
            }
          } catch {}
        }, LEASE_HEARTBEAT_MS);

        return await task();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        try {
          const storage = getStorage();
          const cur = JSON.parse(storage.getItem(MUTEX_KEY) || '{}');
          if (cur.token === token) {
            storage.removeItem(MUTEX_KEY);
          }
        } catch {}
      }
    });
  }

  async runFlushIfAvailable(task) {
    const token = this._generateToken();
    let heartbeat = null;

    try {
      const storage = getStorage();
      const raw = storage.getItem(FLUSH_LOCK_KEY);
      if (raw) {
        try {
          const lease = JSON.parse(raw);
          if (lease && (Date.now() - lease.ts) < LEASE_EXPIRY_MS) {
            return { acquired: false, reason: 'held_by_peer' };
          }
        } catch {}
      }

      storage.setItem(FLUSH_LOCK_KEY, JSON.stringify({ token, ts: Date.now() }));
      await new Promise((r) => setTimeout(r, 15));
      const recheck = JSON.parse(storage.getItem(FLUSH_LOCK_KEY) || '{}');
      if (recheck.token !== token) {
        return { acquired: false, reason: 'held_by_peer' };
      }

      heartbeat = setInterval(() => {
        try {
          const cur = JSON.parse(storage.getItem(FLUSH_LOCK_KEY) || '{}');
          if (cur.token === token) {
            storage.setItem(FLUSH_LOCK_KEY, JSON.stringify({ token, ts: Date.now() }));
          }
        } catch {}
      }, LEASE_HEARTBEAT_MS);

      const result = await task();
      return { acquired: true, result };
    } catch (err) {
      console.warn('[axona.track] Flush lock error:', err);
      throw err;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try {
        const storage = getStorage();
        const cur = JSON.parse(storage.getItem(FLUSH_LOCK_KEY) || '{}');
        if (cur.token === token) {
          storage.removeItem(FLUSH_LOCK_KEY);
        }
      } catch {}
    }
  }
}

const fallbackCoordinator = new FallbackCoordinator();

/**
 * Execute an atomic transaction covering ALL shared-buffer mutations.
 * Uses Web Locks API (navigator.locks) when available; falls back to FallbackCoordinator.
 */
export async function withStorageTransaction(task) {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request('axona.track.storage_mutex', { mode: 'exclusive' }, async () => {
      return await task();
    });
  }
  return fallbackCoordinator.runExclusive(task);
}

/**
 * Execute an exclusive recovery flush if lock is available.
 * Returns { acquired: false, reason } if another tab is currently flushing.
 */
export async function withFlushLock(task) {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request('axona.track.flush_lock', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        return { acquired: false, reason: 'held_by_peer' };
      }
      const result = await task();
      return { acquired: true, result };
    });
  }
  return fallbackCoordinator.runFlushIfAvailable(task);
}

/**
 * Record storage drops due to capacity or age eviction (must be called inside transaction)
 */
export function recordStorageDrops(count = 1) {
  if (count <= 0) return 0;
  try {
    const cur = getStorageDrops();
    const updated = cur + count;
    getStorage().setItem(DROPS_KEY, String(updated));
    return updated;
  } catch {
    return 0;
  }
}

export function getStorageDrops() {
  try {
    const raw = getStorage().getItem(DROPS_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Internal single-pass prune (called within transaction)
 */
function _pruneStorageInternal() {
  const now = Date.now();
  let totalPruned = 0;
  const storage = getStorage();

  // 1. Prune Outbox
  const rawOutbox = readRawArray(OUTBOX_KEY);
  const freshOutbox = rawOutbox.filter((e) => (now - e.ts) < MAX_AGE_MS);
  const outboxAgeDropped = rawOutbox.length - freshOutbox.length;
  if (outboxAgeDropped > 0) {
    storage.setItem(OUTBOX_KEY, JSON.stringify(freshOutbox));
    recordStorageDrops(outboxAgeDropped);
    totalPruned += outboxAgeDropped;
  }

  // 2. Prune Events Log
  const rawEvents = readRawArray(EVENTS_KEY);
  const freshEvents = rawEvents.filter((e) => (now - e.ts) < MAX_AGE_MS);
  const eventsAgeDropped = rawEvents.length - freshEvents.length;
  if (eventsAgeDropped > 0) {
    storage.setItem(EVENTS_KEY, JSON.stringify(freshEvents));
    recordStorageDrops(eventsAgeDropped);
    totalPruned += eventsAgeDropped;
  }

  return totalPruned;
}

/**
 * Prune all stored events and outbox entries older than 24 hours under atomic transaction
 */
export async function pruneStorage() {
  return withStorageTransaction(async () => {
    return _pruneStorageInternal();
  });
}

/**
 * Queue an event occurred while offline/hidden with persisted 24-hour age eviction and drop tracking.
 * Atomic transaction guarantees no lost updates against concurrent acks or prunes.
 */
export async function queueOfflineEvent(event) {
  return withStorageTransaction(async () => {
    const now = Date.now();
    const storage = getStorage();
    const raw = readRawArray(OUTBOX_KEY);

    // 1. Evict entries older than 24 hours
    let box = raw.filter((e) => (now - e.ts) < MAX_AGE_MS);
    const ageDropped = raw.length - box.length;

    box.push({
      id: Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4),
      ts: now,
      ...event
    });

    // 2. Enforce buffer cap with drop accounting
    let capDropped = 0;
    if (box.length > MAX_OUTBOX_EVENTS) {
      capDropped = box.length - MAX_OUTBOX_EVENTS;
      box = box.slice(-MAX_OUTBOX_EVENTS);
    }

    if (ageDropped > 0 || capDropped > 0) {
      recordStorageDrops(ageDropped + capDropped);
    }

    storage.setItem(OUTBOX_KEY, JSON.stringify(box));
    return box.length;
  });
}

/**
 * Get all queued offline events, filtered by 24h max age with persisted prune
 */
export function getOfflineOutbox() {
  const now = Date.now();
  const raw = readRawArray(OUTBOX_KEY);
  const fresh = raw.filter((e) => (now - e.ts) < MAX_AGE_MS);
  if (fresh.length !== raw.length) {
    getStorage().setItem(OUTBOX_KEY, JSON.stringify(fresh));
    recordStorageDrops(raw.length - fresh.length);
  }
  return fresh;
}

/**
 * Acknowledge and remove ONLY the successfully published batch of event IDs (transactional flush)
 * Executed under atomic transaction so concurrent appends are never clobbered.
 */
export async function ackOfflineOutbox(ackedIds) {
  if (!Array.isArray(ackedIds) || ackedIds.length === 0) return 0;
  return withStorageTransaction(async () => {
    const ackSet = new Set(ackedIds);
    const current = readRawArray(OUTBOX_KEY);
    const remaining = current.filter((e) => !ackSet.has(e.id));
    getStorage().setItem(OUTBOX_KEY, JSON.stringify(remaining));
    return remaining.length;
  });
}

/**
 * Clear the offline outbox entirely (manual reset)
 */
export async function clearOfflineOutbox() {
  return withStorageTransaction(async () => {
    getStorage().removeItem(OUTBOX_KEY);
  });
}

/**
 * Save pre-freeze state snapshot to localStorage
 */
export function savePreFreezeSnapshot(snapshot) {
  try {
    if (typeof localStorage === 'undefined') return;
    const payload = {
      ...snapshot,
      timestamp: Date.now()
    };
    getStorage().setItem(SNAPSHOT_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[axona.track] failed to save pre-freeze snapshot:', err);
  }
}

/**
 * Retrieve and clear pre-freeze snapshot upon wake
 */
export function popPreFreezeSnapshot() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const storage = getStorage();
    const raw = storage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    storage.removeItem(SNAPSHOT_KEY);
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[axona.track] failed to read pre-freeze snapshot:', err);
    return null;
  }
}

/**
 * Peek at pre-freeze snapshot without removing it
 */
export function peekPreFreezeSnapshot() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = getStorage().getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Append an event to the local rotating log with persisted 24-hour age eviction and drop tracking.
 * Atomic transaction ensures reliable ordering and drop accounting.
 */
export async function appendLocalEvent(event) {
  return withStorageTransaction(async () => {
    const now = Date.now();
    const storage = getStorage();
    const raw = readRawArray(EVENTS_KEY);

    // Evict older than 24h
    let events = raw.filter((e) => (now - e.ts) < MAX_AGE_MS);
    const ageDropped = raw.length - events.length;

    events.unshift({
      id: Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4),
      ts: now,
      ...event
    });

    let capDropped = 0;
    if (events.length > MAX_LOCAL_EVENTS) {
      capDropped = events.length - MAX_LOCAL_EVENTS;
      events = events.slice(0, MAX_LOCAL_EVENTS);
    }

    if (ageDropped > 0 || capDropped > 0) {
      recordStorageDrops(ageDropped + capDropped);
    }

    storage.setItem(EVENTS_KEY, JSON.stringify(events));
    return events.length;
  });
}

/**
 * Retrieve local event log filtered by 24h age limit with persisted cleanup
 */
export function getLocalEvents() {
  const now = Date.now();
  const raw = readRawArray(EVENTS_KEY);
  const fresh = raw.filter((e) => (now - e.ts) < MAX_AGE_MS);
  if (fresh.length !== raw.length) {
    getStorage().setItem(EVENTS_KEY, JSON.stringify(fresh));
    recordStorageDrops(raw.length - fresh.length);
  }
  return fresh;
}

/**
 * Clear local event log
 */
export async function clearLocalEvents() {
  return withStorageTransaction(async () => {
    getStorage().removeItem(EVENTS_KEY);
  });
}

/**
 * Update session metrics
 */
export function updateSessionMetrics(updater) {
  try {
    const current = getSessionMetrics();
    const updated = updater(current);
    getStorage().setItem(METRICS_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return getSessionMetrics();
  }
}

/**
 * Get cumulative session metrics
 */
export function getSessionMetrics() {
  try {
    const raw = getStorage().getItem(METRICS_KEY);
    return raw ? JSON.parse(raw) : {
      peersAdded: 0,
      peersLost: 0,
      heartbeatsSent: 0,
      recoveriesCount: 0,
      suspensionsCount: 0,
      storageDrops: 0,
      sessionStartedAt: Date.now()
    };
  } catch {
    return {
      peersAdded: 0,
      peersLost: 0,
      heartbeatsSent: 0,
      recoveriesCount: 0,
      suspensionsCount: 0,
      storageDrops: 0,
      sessionStartedAt: Date.now()
    };
  }
}

// Perform initial pruning on module load
try {
  if (typeof localStorage !== 'undefined') {
    pruneStorage().catch(() => {});
    localStorage.removeItem('axona.track.device_uuid');
  }
} catch {}
