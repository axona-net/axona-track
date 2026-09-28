// src/updater.js — PWA service-worker update coordinator for axona.track
// Aligns with axona.chat's battle-tested update policy:
// 1. Checks every 60 seconds, on visibilitychange (visible), and on online.
// 2. Automated activation: skips waiting gracefully (2500ms grace period).
// 3. Defers if user is editing or has interactive modal open (rechecks every 2000ms).
// 4. Applies immediately when tab goes hidden.
// 5. Workbox clientsClaim forces controllerchange, triggering a clean page reload.

import { registerSW } from 'virtual:pwa-register';

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60s
const APPLY_GRACE_MS = 2500;        // Grace period to display update notice
const BUSY_RECHECK_MS = 2000;       // Re-check interval while user is active

function userIsEditing() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  const qrModal = document.getElementById('qrModal');
  if (qrModal && qrModal.style.display !== 'none') return true;
  return false;
}

export function initPWAUpdater({ onNotice, onApplying } = {}) {
  let updateServiceWorker = null;
  let needRefresh = false;
  let applying = false;
  let deferred = false;
  let timer = null;

  function applyUpdate() {
    if (applying) return;
    applying = true;
    if (timer) clearTimeout(timer);

    if (onApplying) onApplying();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        console.log('[axona.track] Service worker controller changed; refreshing page to new version');
        window.location.reload();
      });
    }

    if (updateServiceWorker) {
      updateServiceWorker(true);
    } else {
      window.location.reload();
    }
  }

  function attemptApply() {
    if (applying) return;

    if (userIsEditing()) {
      if (!deferred) {
        deferred = true;
        if (onNotice) {
          onNotice({
            status: 'deferred',
            message: '✨ Update ready — will apply when you finish interacting.'
          });
        }
      }
      timer = setTimeout(attemptApply, BUSY_RECHECK_MS);
      return;
    }

    deferred = false;
    if (onNotice) {
      onNotice({
        status: 'applying',
        message: '✨ Updating axona.track to the latest version…'
      });
    }
    applyUpdate();
  }

  function scheduleApply() {
    needRefresh = true;
    if (document.visibilityState === 'hidden') {
      // Hidden tab is the safest moment — apply immediately
      applyUpdate();
      return;
    }

    if (onNotice) {
      onNotice({
        status: 'ready',
        message: '✨ New version ready — updating momentarily…'
      });
    }
    timer = setTimeout(attemptApply, APPLY_GRACE_MS);
  }

  // Hidden tab hook
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && needRefresh) {
      applyUpdate();
    }
  });

  try {
    updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh() {
        console.log('[axona.track] Service worker reports new build waiting');
        scheduleApply();
      },
      onOfflineReady() {
        console.log('[axona.track] App cached and ready for offline use');
      },
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;
        const check = () => {
          registration.update().catch(() => {});
        };
        // 60-second polling check
        setInterval(check, CHECK_INTERVAL_MS);
        // Foreground return
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
        // Network reconnect
        window.addEventListener('online', check);
      }
    });
  } catch (err) {
    console.warn('[axona.track] Service worker registration error:', err);
  }

  return {
    applyNow() {
      applyUpdate();
    }
  };
}
