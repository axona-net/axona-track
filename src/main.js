// src/main.js — Main application entrypoint for axona.track

import './style.css';
import { getOrCreateDeviceId, detectPlatform } from './id.js';
import { MeshClient } from './mesh.js';
import { LifecycleMonitor } from './lifecycle.js';
import { TelemetryService } from './telemetry.js';
import { TrackUI } from './ui.js';
import { appendLocalEvent } from './storage.js';
import { registerSW } from 'virtual:pwa-register';

// Auto-register service worker for PWA offline capabilities
try {
  registerSW({ immediate: true });
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
    },
    onMessage: (msg, signer) => {
      // Remote telemetry messages from other nodes on #axona-track
      if (msg && msg.deviceName && msg.deviceName !== deviceId.name) {
        if (msg.type === 'heartbeat') {
          appendLocalEvent({
            category: 'remote',
            title: `Remote Heartbeat: ${msg.deviceName}`,
            detail: `${msg.platform?.os} · ${msg.mesh?.peerCount ?? '?'} peers · ${msg.lifecycleState}`,
            payload: msg
          });
        } else if (msg.type === 'recovery') {
          appendLocalEvent({
            category: 'remote',
            title: `Remote Recovery: ${msg.deviceName}`,
            detail: `Sleep: ${Math.round((msg.sleepDurationMs || 0) / 1000)}s · Dispo: ${msg.recoveryDisposition}`,
            payload: msg
          });
        }
        ui?._renderEventList();
      }
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

  // Send initial startup heartbeat
  setTimeout(() => {
    telemetry.sendHeartbeat('startup');
  }, 1000);
}

window.addEventListener('DOMContentLoaded', initApp);
