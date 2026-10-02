// src/main.js — Main application entrypoint for axona.track

import './style.css';
import { getOrCreateDeviceId, detectPlatform } from './id.js';
import { MeshClient } from './mesh.js';
import { LifecycleMonitor } from './lifecycle.js';
import { TelemetryService } from './telemetry.js';
import { TrackUI } from './ui.js';
import { appendLocalEvent } from './storage.js';
import { initPWAUpdater } from './updater.js';
import { AdaptationLab } from './lab.js';

let updater = null;

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

  // Initialize Adaptation Lab (v0.2.0)
  const lab = new AdaptationLab({
    mesh,
    lifecycle,
    telemetry,
    mode: 'offline_mock'
  });

  // Initialize UI
  ui = new TrackUI({
    container,
    deviceId,
    platform,
    mesh,
    lifecycle,
    telemetry,
    lab
  });

  // Initialize PWA Auto-Updater Lifecycle
  updater = initPWAUpdater({
    onNotice: ({ status, message }) => {
      ui?.showUpdateBanner({
        status,
        message,
        onApply: () => updater.applyNow()
      });
    },
    onApplying: () => {
      ui?.showUpdateBanner({
        status: 'applying',
        message: '✨ Updating axona.track to latest version…'
      });
    }
  });

  ui.updater = updater;

  // Connect Mesh
  await mesh.start();
  ui.updateMeshMetrics();
  ui.updateEnvironmentUI();
}

window.addEventListener('DOMContentLoaded', initApp);
