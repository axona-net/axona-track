// src/lifecycle.js — Multi-tier Page Lifecycle monitor & Time-Dilation watchdog

/**
 * State enum:
 * 'ACTIVE'    - Tab focused & visible
 * 'PASSIVE'   - Tab visible but unfocused
 * 'HIDDEN'    - Tab hidden / minimized
 * 'FROZEN'    - OS suspended page execution
 * 'RESUMED'   - Returned from background / freeze
 * 'OFFLINE'   - Network interface disconnected
 */

export class LifecycleMonitor {
  constructor({ onStateChange, onPreFreeze, onResume, onOnlineChange }) {
    this.onStateChange = onStateChange || (() => {});
    this.onPreFreeze   = onPreFreeze || (() => {});
    this.onResume      = onResume || (() => {});
    this.onOnlineChange = onOnlineChange || (() => {});

    this.state = this._determineInitialState();
    this.lastActiveTime = Date.now();
    this.freezeTimestamp = null;
    this.isFrozen = false;

    // Time-dilation drift watchdog
    this._watchdogInterval = null;
    this._lastWatchdogTick = Date.now();
    this.TICK_INTERVAL_MS = 1000;
    this.DRIFT_THRESHOLD_MS = 2500; // if tick took > 2.5s, OS paused execution

    this._bindEvents();
    this._startWatchdog();
  }

  _determineInitialState() {
    if (!navigator.onLine) return 'OFFLINE';
    if (document.visibilityState === 'hidden') return 'HIDDEN';
    if (document.hasFocus && !document.hasFocus()) return 'PASSIVE';
    return 'ACTIVE';
  }

  _setState(newState, detail = {}) {
    if (this.state === newState && !detail.force) return;
    const oldState = this.state;
    this.state = newState;
    this.onStateChange(newState, oldState, detail);
  }

  _bindEvents() {
    // 1. Visibility Change (hidden / visible)
    document.addEventListener('visibilitychange', () => {
      const isHidden = document.visibilityState === 'hidden';
      if (isHidden) {
        this._handleHidden();
      } else {
        this._handleVisible();
      }
    });

    // 2. Page Lifecycle API: freeze
    window.addEventListener('freeze', (ev) => {
      this._handleFreeze('freeze_event', ev);
    });

    // 3. Page Lifecycle API: resume
    window.addEventListener('resume', (ev) => {
      this._handleResume('resume_event', ev);
    });

    // 4. PageHide / PageShow
    window.addEventListener('pagehide', (ev) => {
      this._handleFreeze('pagehide', { persisted: ev.persisted });
    });

    window.addEventListener('pageshow', (ev) => {
      if (ev.persisted) {
        this._handleResume('pageshow_persisted', ev);
      }
    });

    // 5. Network online / offline
    window.addEventListener('online', () => {
      this.onOnlineChange(true);
      if (this.state === 'OFFLINE') {
        this._setState(this._determineInitialState(), { reason: 'network_online' });
      }
    });

    window.addEventListener('offline', () => {
      this.onOnlineChange(false);
      this._setState('OFFLINE', { reason: 'network_offline' });
    });

    // 6. Focus / Blur
    window.addEventListener('focus', () => {
      if (this.state === 'PASSIVE') {
        this._setState('ACTIVE', { reason: 'focus' });
      }
    });

    window.addEventListener('blur', () => {
      if (this.state === 'ACTIVE') {
        this._setState('PASSIVE', { reason: 'blur' });
      }
    });
  }

  _handleHidden() {
    this.freezeTimestamp = Date.now();
    this.onPreFreeze({
      trigger: 'visibility_hidden',
      stateBefore: this.state,
      freezeTime: this.freezeTimestamp
    });
    this._setState('HIDDEN', { reason: 'visibility_hidden' });
  }

  _handleVisible() {
    const now = Date.now();
    const sleepDuration = this.freezeTimestamp ? (now - this.freezeTimestamp) : 0;
    this.freezeTimestamp = null;
    this.lastActiveTime = now;

    if (sleepDuration > 1000) {
      this.onResume({
        trigger: 'visibility_visible',
        sleepDurationMs: sleepDuration,
        wasSevered: sleepDuration > 5000
      });
    }

    this._setState('ACTIVE', { reason: 'visibility_visible', sleepDurationMs: sleepDuration });
  }

  _handleFreeze(trigger, detail) {
    if (this.isFrozen) return;
    this.isFrozen = true;
    this.freezeTimestamp = Date.now();

    this.onPreFreeze({
      trigger,
      detail,
      stateBefore: this.state,
      freezeTime: this.freezeTimestamp
    });

    this._setState('FROZEN', { trigger, detail });
  }

  _handleResume(trigger, detail) {
    if (!this.isFrozen && !this.freezeTimestamp) return;
    const now = Date.now();
    const sleepDuration = this.freezeTimestamp ? (now - this.freezeTimestamp) : 0;
    this.isFrozen = false;
    this.freezeTimestamp = null;
    this.lastActiveTime = now;

    this.onResume({
      trigger,
      detail,
      sleepDurationMs: sleepDuration,
      wasSevered: true
    });

    this._setState('RESUMED', { trigger, sleepDurationMs: sleepDuration });

    setTimeout(() => {
      if (this.state === 'RESUMED') {
        this._setState(this._determineInitialState(), { reason: 'settled_after_resume' });
      }
    }, 1500);
  }

  /**
   * Time-Dilation Drift Watchdog:
   * Detects OS execution suspension even when event handlers were suppressed
   */
  _startWatchdog() {
    this._lastWatchdogTick = Date.now();
    this._watchdogInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this._lastWatchdogTick;
      this._lastWatchdogTick = now;

      // If tick was delayed significantly past expected interval, OS suspended execution
      if (delta > this.DRIFT_THRESHOLD_MS) {
        const sleepDuration = delta - this.TICK_INTERVAL_MS;
        console.warn(`[axona.track] Time-dilation detected! Suspended for ${sleepDuration}ms`);

        this.onResume({
          trigger: 'time_dilation_watchdog',
          sleepDurationMs: sleepDuration,
          wasSevered: sleepDuration > 5000
        });

        this._setState('RESUMED', {
          trigger: 'time_dilation_watchdog',
          sleepDurationMs: sleepDuration
        });

        setTimeout(() => {
          if (this.state === 'RESUMED') {
            this._setState(this._determineInitialState(), { reason: 'settled_after_watchdog' });
          }
        }, 1500);
      }
    }, this.TICK_INTERVAL_MS);
  }

  /**
   * Manually simulate background freeze for testing recovery pipeline
   */
  simulateFreeze(durationMs = 5000) {
    console.log(`[axona.track] Simulating background freeze (${durationMs}ms)...`);
    this._handleFreeze('manual_simulation', { simulatedDurationMs: durationMs });

    setTimeout(() => {
      this._handleResume('manual_simulation_resume', { simulatedDurationMs: durationMs });
    }, durationMs);
  }

  destroy() {
    if (this._watchdogInterval) clearInterval(this._watchdogInterval);
  }
}
