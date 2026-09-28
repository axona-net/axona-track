// src/storage.js — Local persistence for events, pre-freeze snapshots, and session metrics

const SNAPSHOT_KEY = 'axona.track.pre_freeze_snapshot';
const EVENTS_KEY   = 'axona.track.events_log';
const METRICS_KEY  = 'axona.track.session_metrics';
const OUTBOX_KEY   = 'axona.track.offline_outbox';
const MAX_LOCAL_EVENTS = 500;

/**
 * Queue an event occurred while offline/hidden to be flushed upon full visible recovery
 */
export function queueOfflineEvent(event) {
  try {
    const box = getOfflineOutbox();
    box.push({
      id: Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      ...event
    });
    if (box.length > 200) box.shift();
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(box));
  } catch (err) {
    console.warn('[axona.track] failed to queue offline event:', err);
  }
}

/**
 * Get all queued offline events
 */
export function getOfflineOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Clear the offline outbox after successful batch flush
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
 * Append an event to the local rotating log
 */
export function appendLocalEvent(event) {
  try {
    const events = getLocalEvents();
    events.unshift({
      id: (typeof crypto.randomUUID === 'function') ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      ...event
    });

    if (events.length > MAX_LOCAL_EVENTS) {
      events.length = MAX_LOCAL_EVENTS;
    }

    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch (err) {
    console.warn('[axona.track] failed to append event:', err);
  }
}

/**
 * Retrieve local event log
 */
export function getLocalEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    return raw ? JSON.parse(raw) : [];
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
 * Update session metrics (churn, connects, drops)
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
      sessionStartedAt: Date.now()
    };
  } catch {
    return {
      peersAdded: 0,
      peersLost: 0,
      heartbeatsSent: 0,
      recoveriesCount: 0,
      suspensionsCount: 0,
      sessionStartedAt: Date.now()
    };
  }
}
