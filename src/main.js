// src/main.js — Main application entrypoint for axona.track

import './style.css';
import { getOrCreateDeviceId, detectPlatform } from './id.js';
import { MeshClient } from './mesh.js';
import { LifecycleMonitor } from './lifecycle.js';
import { TelemetryService } from './telemetry.js';
import { TrackUI } from './ui.js';
import { appendLocalEvent } from './storage.js';
import { registerSW } from 'virtual:pwa-register';

// Auto-register service worker for PWA offline capabilities with automated reload on update
try {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      console.log('[axona.track] New PWA bundle available; activating and refreshing');
      updateSW(true);
    },
    onOfflineReady() {
      console.log('[axona.track] App cached and ready for offline use');
    }
  });

  // Check for updates whenever the tab/PWA returns to foreground
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateSW?.();
    }
  });

  // Periodic background check every 15 minutes
  setInterval(() => {
    updateSW?.();
  }, 15 * 60 * 1000);

  // Reload page when new service worker activates and claims the client
  if ('serviceWorker' in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        console.log('[axona.track] Service worker controller changed; refreshing page to new version');
        window.location.reload();
      }
    });
  }
} catch (err) {
  console.warn('[axona.track] Service worker registration notice:', err);
}

async function initApp() {
  const container = document.getElementById('app');
  if (!container) return;

  const deviceId = getOrCreateDeviceId();
  const platform = detectPlatform();

  console.log(`[axona.track] Starting on ${platform.os} (${platform.browser}, ${platform.displayMode}) as ${deviceId.name}`);

  let ui = null;
  let telemetry = null;

  // Initialize Lifecycle Monitor
  const lifecycle = new LifecycleMonitor({
    onStateChange: (newState, oldState, detail) => {
      ui?.updateLifecycleUI(newState, oldState, detail);
    },
    onPreFreeze: (freezeDetail) => {
      console.log('[axona.track] Pre-freeze hook:', freezeDetail);
    },
    onResume: (resumeDetail) => {
      console.log('[axona.track] On-resume hook:', resumeDetail);
    },
    onOnlineChange: (online) => {
      ui?.updateEnvironmentUI();
    },
    onConnectivityWarning: (warnDetail) => {
      console.warn('[axona.track] Connectivity warning:', warnDetail);
    }
  });

  // Initialize Mesh Client
  const mesh = new MeshClient({
    onStatus: (status, message) => {
      ui?.updateBridgeStatus(status, message);
      ui?.updateMeshMetrics();
    },
    onPeerAdded: (peer) => {
      ui?.updateMeshMetrics();
      ui?.showToast(`Peer connected (${peer.candidateType})`);
    },
    onPeerLost: (loss) => {
      ui?.updateMeshMetrics();
    },
    onPeerStats: () => {
      ui?.updateMeshMetrics();
    }
  });

  // Initialize Telemetry Service
  telemetry = new TelemetryService({
    mesh,
    lifecycle,
    deviceId,
    onTelemetryEvent: () => {
      ui?._renderEventList();
      ui?.updateMeshMetrics();
    }
  });

  // Initialize UI
  ui = new TrackUI({
    container,
    deviceId,
    platform,
    mesh,
    lifecycle,
    telemetry
  });

  // Connect Mesh
  await mesh.start();
  ui.updateMeshMetrics();
  ui.updateEnvironmentUI();
}

window.addEventListener('DOMContentLoaded', initApp);
