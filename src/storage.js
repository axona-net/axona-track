// src/storage.js — Local persistence for events, pre-freeze snapshots, outbox, and session metrics

const SNAPSHOT_KEY = 'axona.track.pre_freeze_snapshot';
const EVENTS_KEY   = 'axona.track.events_log';
const METRICS_KEY  = 'axona.track.session_metrics';
const OUTBOX_KEY   = 'axona.track.offline_outbox';
const DROPS_KEY    = 'axona.track.storage_drops';

const MAX_LOCAL_EVENTS = 500;
const MAX_OUTBOX_EVENTS = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24-hour retention limit (Aster seq 469)

/**
 * Record storage drops due to capacity or age eviction
 */
export function recordStorageDrops(count = 1) {
  try {
    const cur = getStorageDrops();
    const updated = cur + count;
    localStorage.setItem(DROPS_KEY, String(updated));
    return updated;
  } catch {
    return 0;
  }
}

export function getStorageDrops() {
  try {
    const raw = localStorage.getItem(DROPS_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Queue an event occurred while offline/hidden with 24-hour age eviction and drop tracking
 */
export function queueOfflineEvent(event) {
  try {
    const now = Date.now();
    let box = getOfflineOutbox();

    // 1. Evict entries older than 24 hours
    const fresh = box.filter((e) => (now - e.ts) < MAX_AGE_MS);
    const ageDropped = box.length - fresh.length;
    box = fresh;

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

    localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
  } catch (err) {
    console.warn('[axona.track] failed to queue offline event:', err);
  }
}

/**
 * Get all queued offline events, filtered by 24h max age
 */
export function getOfflineOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const now = Date.now();
    return Array.isArray(parsed) ? parsed.filter((e) => (now - e.ts) < MAX_AGE_MS) : [];
  } catch {
    return [];
  }
}

/**
 * Acknowledge and remove ONLY the successfully published batch of event IDs (transactional flush)
 * Preserves any new events appended concurrently.
 */
export function ackOfflineOutbox(ackedIds) {
  if (!Array.isArray(ackedIds) || ackedIds.length === 0) return;
  try {
    const ackSet = new Set(ackedIds);
    const current = getOfflineOutbox();
    const remaining = current.filter((e) => !ackSet.has(e.id));
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(remaining));
  } catch (err) {
    console.warn('[axona.track] failed to ack outbox batch:', err);
  }
}

/**
 * Clear the offline outbox entirely (manual reset)
 */
export function clearOfflineOutbox() {
  try {
    localStorage.removeItem(OUTBOX_KEY);
  } catch {}
}

/**
 * Save pre-freeze state snapshot to localStorage
 */
export function savePreFreezeSnapshot(snapshot) {
  try {
    const payload = {
      ...snapshot,
      timestamp: Date.now()
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[axona.track] failed to save pre-freeze snapshot:', err);
  }
}

/**
 * Retrieve and clear pre-freeze snapshot upon wake
 */
export function popPreFreezeSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    localStorage.removeItem(SNAPSHOT_KEY);
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
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Append an event to the local rotating log with 24-hour age eviction
 */
export function appendLocalEvent(event) {
  try {
    const now = Date.now();
    let events = getLocalEvents();

    events.unshift({
      id: Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4),
      ts: now,
      ...event
    });

    // Evict older than 24h
    events = events.filter((e) => (now - e.ts) < MAX_AGE_MS);

    if (events.length > MAX_LOCAL_EVENTS) {
      events.length = MAX_LOCAL_EVENTS;
    }

    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch (err) {
    console.warn('[axona.track] failed to append event:', err);
  }
}

/**
 * Retrieve local event log filtered by 24h age limit
 */
export function getLocalEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const now = Date.now();
    return Array.isArray(parsed) ? parsed.filter((e) => (now - e.ts) < MAX_AGE_MS) : [];
  } catch {
    return [];
  }
}

/**
 * Clear local event log
 */
export function clearLocalEvents() {
  try {
    localStorage.removeItem(EVENTS_KEY);
  } catch {}
}

/**
 * Update session metrics
 */
export function updateSessionMetrics(updater) {
  try {
    const current = getSessionMetrics();
    const updated = updater(current);
    localStorage.setItem(METRICS_KEY, JSON.stringify(updated));
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
    const raw = localStorage.getItem(METRICS_KEY);
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
