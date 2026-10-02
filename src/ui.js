// src/ui.js — UI renderer and state binding for axona.track

import { getLocalEvents, clearLocalEvents, getSessionMetrics } from './storage.js';
import { APP_VERSION, KERNEL_VERSION } from './version.js';
import QRCode from 'qrcode';

export class TrackUI {
  constructor({ container, deviceId, platform, mesh, lifecycle, telemetry, lab }) {
    this.container = container;
    this.deviceId = deviceId;
    this.platform = platform;
    this.mesh = mesh;
    this.lifecycle = lifecycle;
    this.telemetry = telemetry;
    this.lab = lab;

    this.currentFilter = 'all';
    this.stateStartTime = Date.now();
    this.lastState = lifecycle.state;
    this.visibleEventCount = 30;
    this._renderDebounceTimer = null;
    this._eventsMap = new Map();
    this._lastMetricsFetch = 0;
    this._cachedMetrics = null;
    this._batteryPromise = null;

    this._mountLayout();
    this._bindEvents();
    this._renderEventList(true);
    this._startUIRefreshLoop();
  }

  _mountLayout() {
    this.container.innerHTML = `
      <div class="app-container">
        <!-- Header -->
        <header class="app-header">
          <div class="header-top">
            <div class="brand-wrapper">
              <div class="brand-logo">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <h1 class="brand-title">axona.track</h1>
              <span class="brand-version pill-clickable" id="versionBadge" title="Tap to check for application updates">v${APP_VERSION} · kernel v${KERNEL_VERSION}</span>
            </div>

            <div class="header-badges">
              <button class="pill pill-qr pill-clickable" id="btnOpenQr" title="Display mobile launch QR code">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="7" height="7"></rect>
                  <rect x="14" y="3" width="7" height="7"></rect>
                  <rect x="14" y="14" width="7" height="7"></rect>
                  <rect x="3" y="14" width="7" height="7"></rect>
                </svg>
                <span>📱 Scan QR</span>
              </button>
              <div class="pill pill-device pill-clickable" id="copyDevicePill" title="Click to copy device name">
                <span class="status-dot connected"></span>
                <span id="deviceNameLabel">${this.deviceId.name}</span>
              </div>
              <div class="pill pill-browser" id="browserPill" title="Detected Browser & Operating System">
                <span class="status-dot connected"></span>
                <span>🌐 ${this.platform.browser} (${this.platform.os})</span>
              </div>
              <div class="pill pill-pwa">
                <span>${this.platform.isStandalone ? '📱 Standalone PWA' : '🌐 Browser Tab'}</span>
              </div>
              <div class="pill pill-net ${this.mesh.network}" id="networkPill" title="Target Network: ${this.mesh.bridgeUrl}">
                <span>${this.mesh.network === 'prod' ? '⚡ PROD' : '🧪 TESTNET'}</span>
              </div>
              <div class="pill pill-region">
                <span id="regionLabel">${this.mesh.region}</span>
              </div>
              <div class="pill" id="bridgeStatusPill" title="${this.mesh.bridgeUrl}">
                <span class="status-dot connecting" id="bridgeDot"></span>
                <span id="bridgeStatusText">Connecting…</span>
              </div>
            </div>
          </div>

          <!-- Lifecycle Banner -->
          <div class="lifecycle-banner state-${this.lifecycle.state}" id="lifecycleBanner">
            <div class="lifecycle-title-group">
              <span class="status-dot ${this.lifecycle.state.toLowerCase()}" id="lifecycleDot"></span>
              <span class="lifecycle-label">Lifecycle Status:</span>
              <span class="lifecycle-badge" id="lifecycleBadge">${this.lifecycle.state}</span>
            </div>
            <div class="lifecycle-subtext" id="lifecycleSubtext">Monitoring background transitions & time-dilation…</div>
          </div>
        </header>

        <!-- Metrics Grid -->
        <section class="metrics-grid">
          <!-- Peers Card -->
          <div class="glass-card metric-card">
            <div class="metric-header">
              <span>Direct Mesh Peers</span>
              <span class="badge-tag cyan" id="webrtcBadge">0 Direct</span>
            </div>
            <div class="metric-value">
              <span id="peerCountVal">0</span>
              <span class="metric-unit">peers</span>
            </div>
            <div class="metric-detail" id="peerDetail">
              <span>Direct WebRTC: 0 · Bridge:</span> <span class="badge-tag emerald" id="bridgeBadge">Connecting</span>
            </div>
          </div>

          <!-- Latency Card -->
          <div class="glass-card metric-card">
            <div class="metric-header">
              <span>Median RTT</span>
              <span class="badge-tag emerald">Quality</span>
            </div>
            <div class="metric-value">
              <span id="rttVal">--</span>
              <span class="metric-unit" id="rttUnit">ms</span>
            </div>
            <div class="metric-detail" id="rttDetail">
              <span>Mesh latency median</span>
            </div>
          </div>

          <!-- Churn Turnover Card -->
          <div class="glass-card metric-card">
            <div class="metric-header">
              <span>Session Turnover</span>
              <span class="badge-tag amber">Churn</span>
            </div>
            <div class="metric-value">
              <span id="churnVal">+0 / -0</span>
            </div>
            <div class="metric-detail" id="churnDetail">
              <span>Peers added & dropped</span>
            </div>
          </div>

          <!-- Role Resilience Card -->
          <div class="glass-card metric-card">
            <div class="metric-header">
              <span>Topic Roles</span>
              <span class="badge-tag violet" id="dutyBadge">Standby</span>
            </div>
            <div class="metric-value">
              <span id="rolesVal">0</span>
              <span class="metric-unit">active</span>
            </div>
            <div class="metric-detail" id="rolesDetail">
              <span>Root: 0 · Backup: 0</span>
            </div>
          </div>
        </section>

        <!-- System & Hardware Profile -->
        <section class="glass-card profile-section">
          <div class="section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            <span>Device Profile & Environment</span>
          </div>
          <div class="profile-items">
            <div class="profile-item">
              <span class="profile-item-key">OS & Browser</span>
              <span class="profile-item-val" id="profOs">${this.platform.os} · ${this.platform.browser}</span>
            </div>
            <div class="profile-item">
              <span class="profile-item-key">Hardware Cores / RAM</span>
              <span class="profile-item-val" id="profHw">${this.platform.hardwareConcurrency || '?'} cores ${this.platform.deviceMemory ? '· ' + this.platform.deviceMemory + 'GB' : ''}</span>
            </div>
            <div class="profile-item">
              <span class="profile-item-key">Network Link</span>
              <span class="profile-item-val" id="profNet">Detecting…</span>
            </div>
            <div class="profile-item">
              <span class="profile-item-key">Battery State</span>
              <span class="profile-item-val" id="profBat">Probing…</span>
            </div>
          </div>
        </section>

        <!-- Interactive Control Deck -->
        <section class="glass-card">
          <div class="section-title" style="margin-bottom: 12px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span>Diagnostics & Recovery Testing</span>
          </div>
          <div class="controls-grid">
            <button class="btn btn-cyan" id="btnDeckQr">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
              Mobile Launch QR
            </button>
            <button class="btn btn-amber" id="btnSimulateFreeze">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>
              Simulate 5s Freeze
            </button>
            <button class="btn btn-primary" id="btnSendHeartbeat">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
              Emit Heartbeat
            </button>
            <button class="btn btn-violet" id="btnToggleDuty">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              Arm Topic Duty
            </button>
            <button class="btn" id="btnExportLog">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Export JSON Log
            </button>
            <button class="btn" id="btnClearLog">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              Clear Log
            </button>
          </div>
        </section>

        <!-- Mesh Adaptation Lab (v0.2.0) -->
        <section class="glass-card lab-section">
          <div class="lab-header">
            <div class="section-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 2v7.31L4.62 17.5A2 2 0 0 0 6.34 20h11.32a2 2 0 0 0 1.72-2.5L14 9.31V2"></path>
              </svg>
              <span>Mesh Adaptation Lab (Simulations & Studies)</span>
            </div>
            <div class="lab-mode-switch">
              <button class="lab-mode-btn active" id="btnModeOffline">Offline Mock</button>
              <button class="lab-mode-btn" id="btnModeLive">Live Study</button>
            </div>
          </div>

          <div class="lab-grid">
            <!-- Test 1: Handoff -->
            <div class="lab-card">
              <div class="lab-card-title">
                <span>1. Pre-Freeze Handoff</span>
                <span class="badge-tag violet" id="labT1Status">Ready</span>
              </div>
              <div class="lab-card-desc">Simulate pre-freeze role handoff intent dispatch before OS freeze.</div>
              <div class="lab-card-metrics" id="labT1Metrics">Runs: 0 · Last: --</div>
              <button class="btn btn-cyan btn-sm" id="btnRunLabT1" style="font-size: 0.75rem; padding: 6px 10px;">Run Handoff Test</button>
            </div>

            <!-- Test 2: Grace Profiler -->
            <div class="lab-card">
              <div class="lab-card-title">
                <span>2. Grace Profiler</span>
                <span class="badge-tag amber" id="labT2Status">Ready</span>
              </div>
              <div class="lab-card-desc">Classify pause intervals (&lt;10s, 10-60s, 1-5m, &gt;5m) and retention.</div>
              <div class="lab-card-metrics" id="labT2Metrics">Profile: -- · Ratio: --</div>
              <button class="btn btn-amber btn-sm" id="btnRunLabT2" style="font-size: 0.75rem; padding: 6px 10px;">Profile Retention</button>
            </div>

            <!-- Test 3: Fast-Path Probes -->
            <div class="lab-card">
              <div class="lab-card-title">
                <span>3. Fast-Path Probes</span>
                <span class="badge-tag emerald" id="labT3Status">Ready</span>
              </div>
              <div class="lab-card-desc">Active WebRTC channel ping probe (capped at 3 cached peers).</div>
              <div class="lab-card-metrics" id="labT3Metrics">Responsive: -- · RTT: --</div>
              <button class="btn btn-emerald btn-sm" id="btnRunLabT3" style="font-size: 0.75rem; padding: 6px 10px;">Probe Cached Channels</button>
            </div>

            <!-- Test 4: Backpressure Governor -->
            <div class="lab-card">
              <div class="lab-card-title">
                <span>4. Backpressure</span>
                <span class="badge-tag cyan" id="labT4Status">Inactive</span>
              </div>
              <div class="lab-card-desc">Throttle auxiliary telemetry during link degradation (heartbeats protected).</div>
              <div class="lab-card-metrics" id="labT4Metrics">Passed: 0 · Coalesced: 0</div>
              <button class="btn btn-sm" id="btnToggleLabGovernor" style="font-size: 0.75rem; padding: 6px 10px;">Arm Governor</button>
            </div>

            <!-- Test 5: Dynamic Mesh Scaling & Stress Test (v0.3.0) -->
            <div class="lab-card">
              <div class="lab-card-title">
                <span>5. Dynamic Mesh Scaling</span>
                <span class="badge-tag rose" id="labT5Status">Ready</span>
              </div>
              <div class="lab-card-desc">Cycle connection count up & down to measure RTT shift, frame lag & battery impact.</div>
              <div class="lab-card-metrics" id="labT5Metrics">Peak: -- · Lag: -- · Battery: --</div>
              <button class="btn btn-rose btn-sm" id="btnRunLabT5" style="font-size: 0.75rem; padding: 6px 10px;">Run Scaling Stress</button>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;">
            <button class="btn" id="btnExportLab" style="font-size: 0.75rem; padding: 6px 12px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Export Lab Report (Privacy-Safe)
            </button>
          </div>
        </section>

        <!-- Event Timeline Stream -->
        <section class="glass-card timeline-section">
          <div class="timeline-nav">
            <div class="section-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              <span>Telemetry & Lifecycle Timeline</span>
            </div>
            <div class="filter-tabs">
              <button class="filter-tab active" data-filter="all">All</button>
              <button class="filter-tab" data-filter="heartbeat">Heartbeats</button>
              <button class="filter-tab" data-filter="lifecycle">Lifecycle</button>
              <button class="filter-tab" data-filter="churn">Peer Churn</button>
              <button class="filter-tab" data-filter="recovery">Recovery</button>
            </div>
          </div>

          <div class="event-list" id="eventList">
            <!-- Events rendered dynamically -->
          </div>
        </section>
      </div>

      <div class="toast" id="toastNotification">
        <span id="toastMessage">Copied to clipboard!</span>
      </div>

      <!-- Mobile Launch QR Modal -->
      <div class="modal-backdrop" id="qrModal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="qrModalTitle">
        <div class="modal-card">
          <div class="modal-header">
            <div class="modal-title-group">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                <line x1="12" y1="18" x2="12.01" y2="18"></line>
              </svg>
              <h3 id="qrModalTitle">Launch on Mobile Device</h3>
            </div>
            <button class="btn-close" id="btnCloseQr" aria-label="Close modal">✕</button>
          </div>
          <div class="modal-body">
            <p class="modal-desc">Scan with your phone or tablet camera to open axona.track as a mobile mesh telemetry observer.</p>
            <div class="qr-canvas-wrapper">
              <canvas id="qrCanvas" width="220" height="220"></canvas>
            </div>
            <div class="qr-url-box">
              <input type="text" id="qrUrlInput" readonly value="https://axona-net.github.io/axona-track/" />
              <button class="btn btn-primary btn-copy-url" id="btnCopyQrUrl">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Copy Link
              </button>
            </div>
            <div class="qr-hint">
              <span>💡 <strong>Standalone PWA tip:</strong> For continuous background resilience, tap "Add to Home Screen" in mobile Safari or Chrome.</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Update Banner Notification -->
      <div class="update-banner" id="updateBanner" style="display: none;" role="status">
        <div class="update-banner-content">
          <span id="updateBannerText">✨ Updating axona.track to latest version…</span>
          <button class="btn btn-primary btn-sm" id="btnUpdateNow" style="display: none;">Now</button>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    // Copy Device Name
    document.getElementById('copyDevicePill')?.addEventListener('click', () => {
      const name = this.deviceId.name;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(name).then(() => {
          this.showToast(`Device name copied: ${name}`);
        });
      } else {
        this.showToast(`Device: ${name}`);
      }
    });

    // Check for updates on version badge tap
    document.getElementById('versionBadge')?.addEventListener('click', async () => {
      this.showToast('Checking for application updates…');
      if (this.updater && typeof this.updater.checkNow === 'function') {
        const hasUpdate = await this.updater.checkNow();
        if (!hasUpdate) {
          setTimeout(() => this.showToast(`Up to date: v${APP_VERSION}`), 600);
        }
      } else {
        setTimeout(() => this.showToast(`Running v${APP_VERSION}`), 400);
      }
    });

    // Simulate Freeze button
    document.getElementById('btnSimulateFreeze')?.addEventListener('click', () => {
      this.lifecycle.simulateFreeze(5000);
      this.showToast('Simulating 5s background freeze…');
    });

    // Force Heartbeat button
    document.getElementById('btnSendHeartbeat')?.addEventListener('click', async () => {
      this.showToast('Emitting instant heartbeat…');
      await this.telemetry.sendHeartbeat('manual_trigger');
      this._renderEventList();
    });

    // Toggle Role / Duty button
    document.getElementById('btnToggleDuty')?.addEventListener('click', async () => {
      const active = await this.mesh.toggleTestDuty();
      const btn = document.getElementById('btnToggleDuty');
      const badge = document.getElementById('dutyBadge');
      if (active) {
        btn.classList.add('btn-primary');
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg> Disarm Duty (Active)`;
        if (badge) {
          badge.className = 'badge-tag emerald';
          badge.textContent = 'Armed: Backup';
        }
        this.showToast('Test topic duty armed (backup role)');
      } else {
        btn.classList.remove('btn-primary');
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg> Arm Topic Duty`;
        if (badge) {
          badge.className = 'badge-tag violet';
          badge.textContent = 'Standby';
        }
        this.showToast('Test topic duty disarmed');
      }
      this.updateMeshMetrics();
    });

    // Export Log
    document.getElementById('btnExportLog')?.addEventListener('click', () => {
      const events = getLocalEvents();
      const metrics = getSessionMetrics();
      const exportData = {
        exportedAt: new Date().toISOString(),
        deviceId: this.deviceId,
        platform: this.platform,
        sessionMetrics: metrics,
        events
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `axona-track-${this.deviceId.name}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.showToast(`Exported ${events.length} events to JSON`);
    });

    // Clear Log
    document.getElementById('btnClearLog')?.addEventListener('click', () => {
      if (confirm('Clear all local telemetry events?')) {
        clearLocalEvents();
        this._renderEventList(true);
        this.showToast('Local event log cleared');
      }
    });

    // Filter Tabs
    const tabs = document.querySelectorAll('.filter-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', (e) => {
        tabs.forEach((t) => t.classList.remove('active'));
        e.target.classList.add('active');
        this.currentFilter = e.target.getAttribute('data-filter');
        this.visibleEventCount = 30;
        this._renderEventList(true);
      });
    });

    // Delegated click handler on #eventList for "Show More" and lazy JSON expansion
    const eventList = document.getElementById('eventList');
    eventList?.addEventListener('click', (e) => {
      const showMoreBtn = e.target.closest('#btnShowMoreEvents');
      if (showMoreBtn) {
        this.visibleEventCount += 20;
        this._renderEventList(true);
        return;
      }

      const item = e.target.closest('.event-item');
      if (!item) return;

      const id = item.getAttribute('data-id');
      const jsonEl = document.getElementById(`json-${id}`);
      if (jsonEl) {
        const isExpanded = jsonEl.classList.contains('expanded');
        if (!isExpanded && !jsonEl.textContent) {
          const ev = this._eventsMap.get(id);
          if (ev) {
            jsonEl.textContent = JSON.stringify(ev.payload || {}, null, 2);
          }
        }
        jsonEl.classList.toggle('expanded');
      }
    });

    // Mobile QR Modal Handlers
    document.getElementById('btnOpenQr')?.addEventListener('click', () => {
      this.showQrModal();
    });
    document.getElementById('btnDeckQr')?.addEventListener('click', () => {
      this.showQrModal();
    });
    document.getElementById('btnCloseQr')?.addEventListener('click', () => {
      this.hideQrModal();
    });

    const qrModal = document.getElementById('qrModal');
    qrModal?.addEventListener('click', (e) => {
      if (e.target === qrModal) {
        this.hideQrModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideQrModal();
      }
    });

    document.getElementById('btnCopyQrUrl')?.addEventListener('click', () => {
      const urlInput = document.getElementById('qrUrlInput');
      const url = urlInput?.value || 'https://axona-net.github.io/axona-track/';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          this.showToast('Link copied to clipboard!');
        }).catch(() => {
          this.showToast('Copied: ' + url);
        });
      } else {
        urlInput?.select();
        document.execCommand('copy');
        this.showToast('Link copied to clipboard!');
      }
    });

    // Adaptation Lab Handlers (v0.2.0)
    if (this.lab) {
      const btnModeOffline = document.getElementById('btnModeOffline');
      const btnModeLive = document.getElementById('btnModeLive');

      btnModeOffline?.addEventListener('click', () => {
        this.lab.setMode('offline_mock');
        btnModeOffline.classList.add('active');
        btnModeLive?.classList.remove('active');
        this.showToast('Lab mode: Offline Mock (Sandbox)');
      });

      btnModeLive?.addEventListener('click', () => {
        this.lab.setMode('live_study');
        btnModeLive.classList.add('active');
        btnModeOffline?.classList.remove('active');
        this.showToast('Lab mode: Live Study (Manual bounded)');
      });

      // Test 1: Handoff
      document.getElementById('btnRunLabT1')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('labT1Status');
        const metricsEl = document.getElementById('labT1Metrics');
        if (statusEl) {
          statusEl.className = 'badge-tag amber';
          statusEl.textContent = 'Running…';
        }
        const res = await this.lab.runTest1Handoff();
        if (statusEl) {
          statusEl.className = `badge-tag ${res.outcome === 'settled_resolved' ? 'emerald' : 'rose'}`;
          statusEl.textContent = res.outcome;
        }
        if (metricsEl) {
          metricsEl.textContent = `Runs: ${this.lab.history.test1Handoff.length} · ${res.elapsedMs}ms (${res.transportAtDispatch})`;
        }
        this.showToast(`Test 1 Handoff: ${res.outcome} (${res.elapsedMs}ms)`);
      });

      // Test 2: Grace Profiler
      document.getElementById('btnRunLabT2')?.addEventListener('click', () => {
        const statusEl = document.getElementById('labT2Status');
        const metricsEl = document.getElementById('labT2Metrics');
        const res = this.lab.runTest2GracePeriod();
        if (statusEl) {
          statusEl.className = 'badge-tag emerald';
          statusEl.textContent = res.tier.replace(/_/g, ' ');
        }
        if (metricsEl) {
          metricsEl.textContent = `Retention: ${res.survivingPeersCount}/${res.prePeersCount} (${Math.round((res.retentionRatio || 0) * 100)}%) · ${Math.round(res.observedIntervalMs / 1000)}s`;
        }
        this.showToast(`Test 2 Grace: ${res.tier} · ${res.retentionState}`);
      });

      // Test 3: Fast-Path Probes
      document.getElementById('btnRunLabT3')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('labT3Status');
        const metricsEl = document.getElementById('labT3Metrics');
        if (statusEl) {
          statusEl.className = 'badge-tag amber';
          statusEl.textContent = 'Probing…';
        }
        const res = await this.lab.runTest3FastPath();
        if (statusEl) {
          statusEl.className = `badge-tag ${res.responsiveCount > 0 ? 'emerald' : 'rose'}`;
          statusEl.textContent = `${res.responsiveCount}/${res.probedPeersCount} Alive`;
        }
        if (metricsEl) {
          metricsEl.textContent = `Median RTT: ${res.medianProbeRttMs !== null ? res.medianProbeRttMs + 'ms' : 'none'} · Probed: ${res.probedPeersCount}`;
        }
        this.showToast(`Test 3 Active Probe: ${res.responsiveCount}/${res.probedPeersCount} responded`);
      });

      // Test 4: Backpressure Governor Toggle
      document.getElementById('btnToggleLabGovernor')?.addEventListener('click', () => {
        const active = this.lab.toggleGovernor();
        const btn = document.getElementById('btnToggleLabGovernor');
        const statusEl = document.getElementById('labT4Status');
        const metricsEl = document.getElementById('labT4Metrics');
        if (btn) {
          btn.textContent = active ? 'Disarm Governor' : 'Arm Governor';
          btn.className = `btn btn-sm ${active ? 'btn-primary' : ''}`;
        }
        if (statusEl) {
          statusEl.className = `badge-tag ${active ? 'emerald' : 'cyan'}`;
          statusEl.textContent = active ? 'ARMED' : 'Inactive';
        }
        if (metricsEl) {
          const stats = this.lab.getGovernorStats();
          metricsEl.textContent = `Passed: ${stats.passedCount} · Coalesced: ${stats.coalescedCount} · Suppressed: ${stats.suppressedCount}`;
        }
        this.showToast(`Backpressure governor: ${active ? 'ARMED (throttled)' : 'RESTORED'}`);
      });

      // Test 5: Dynamic Mesh Scaling & Stress Test (v0.3.0)
      document.getElementById('btnRunLabT5')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnRunLabT5');
        const statusEl = document.getElementById('labT5Status');
        const metricsEl = document.getElementById('labT5Metrics');
        if (btn) btn.disabled = true;
        if (statusEl) {
          statusEl.className = 'badge-tag amber';
          statusEl.textContent = 'Running…';
        }
        try {
          const res = await this.lab.runTest5MeshScale({
            onProgress: ({ phase, progress, currentPeers }) => {
              if (statusEl) statusEl.textContent = `${phase.replace(/_/g, ' ')} (${currentPeers}p)`;
            }
          });
          if (statusEl) {
            statusEl.className = `badge-tag ${res.status === 'completed' ? 'emerald' : 'rose'}`;
            statusEl.textContent = res.status === 'completed' ? 'Completed' : 'Aborted';
          }
          if (metricsEl) {
            const batText = res.batteryDelta !== null ? `${res.batteryDelta >= 0 ? '-' : '+'}${Math.abs(res.batteryDelta)}%` : 'n/a';
            metricsEl.textContent = `Peak: ${res.peakPeers}p · Lag: ${res.maxEventLoopLagMs}ms · Bat: ${batText}`;
          }
          this.showToast(`Test 5 Scaling: Peak ${res.peakPeers} peers, Lag ${res.maxEventLoopLagMs}ms`);
        } catch (err) {
          if (statusEl) {
            statusEl.className = 'badge-tag rose';
            statusEl.textContent = 'Error';
          }
        } finally {
          if (btn) btn.disabled = false;
        }
      });

      // Export Lab Report (Privacy-Safe)
      document.getElementById('btnExportLab')?.addEventListener('click', () => {
        const report = this.lab.exportReport();
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `axona-track-adaptation-lab-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('Privacy-safe lab report exported');
      });
    }

    // Cross-tab synchronization: debounced re-render when another window writes to storage
    window.addEventListener('storage', (e) => {
      if (e.key === 'axona.track.events_log') {
        this._scheduleRenderEventList();
      }
    });
  }

  showQrModal() {
    const modal = document.getElementById('qrModal');
    if (!modal) return;
    modal.style.display = 'flex';

    const canvas = document.getElementById('qrCanvas');
    const urlInput = document.getElementById('qrUrlInput');
    const appUrl = (typeof window !== 'undefined' && window.location.origin.startsWith('http'))
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://axona-net.github.io/axona-track/';

    if (urlInput) urlInput.value = appUrl;

    if (canvas) {
      QRCode.toCanvas(canvas, appUrl, {
        width: 220,
        margin: 2,
        color: {
          dark: '#090d16',
          light: '#ffffff'
        }
      }, (err) => {
        if (err) console.error('[axona.track] QR draw error:', err);
      });
    }
  }

  hideQrModal() {
    const modal = document.getElementById('qrModal');
    if (modal) modal.style.display = 'none';
  }

  showUpdateBanner({ status, message, onApply }) {
    const banner = document.getElementById('updateBanner');
    const text = document.getElementById('updateBannerText');
    const btnNow = document.getElementById('btnUpdateNow');
    if (!banner || !text) return;

    text.textContent = message;
    banner.style.display = 'flex';

    if (btnNow) {
      if (status === 'deferred' && onApply) {
        btnNow.style.display = 'inline-block';
        btnNow.onclick = () => onApply();
      } else {
        btnNow.style.display = 'none';
      }
    }
  }

  hideUpdateBanner() {
    const banner = document.getElementById('updateBanner');
    if (banner) banner.style.display = 'none';
  }

  showToast(msg) {
    const toast = document.getElementById('toastNotification');
    const label = document.getElementById('toastMessage');
    if (!toast || !label) return;
    label.textContent = msg;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2800);
  }

  updateLifecycleUI(state, oldState, detail) {
    const banner = document.getElementById('lifecycleBanner');
    const badge = document.getElementById('lifecycleBadge');
    const dot = document.getElementById('lifecycleDot');
    const subtext = document.getElementById('lifecycleSubtext');

    if (banner) {
      banner.className = `lifecycle-banner state-${state}`;
    }
    if (badge) badge.textContent = state;
    if (dot) dot.className = `status-dot ${state.toLowerCase()}`;

    let desc = 'Operational';
    if (state === 'ACTIVE') desc = 'Foreground active & focused · full fidelity';
    else if (state === 'PASSIVE') desc = 'Visible but unfocused (another window active) · click to focus';
    else if (state === 'HIDDEN') desc = 'Tab hidden / minimized · pre-freeze snapshot preserved';
    else if (state === 'FROZEN') desc = 'OS execution suspended · zero CPU';
    else if (state === 'RESUMED') desc = `Post-wake recovery · sleep: ${Math.round((detail?.sleepDurationMs || 0) / 1000)}s`;
    else if (state === 'OFFLINE') desc = 'Network interface disconnected';

    if (subtext) subtext.textContent = desc;
  }

  updateBridgeStatus(status, message) {
    const pill = document.getElementById('bridgeStatusPill');
    const dot = document.getElementById('bridgeDot');
    const text = document.getElementById('bridgeStatusText');
    const bridgeBadge = document.getElementById('bridgeBadge');

    if (dot) dot.className = `status-dot ${status}`;
    if (text) text.textContent = status === 'connected' ? 'Bridge Live' : status;
    if (bridgeBadge) {
      bridgeBadge.className = `badge-tag ${status === 'connected' ? 'emerald' : status === 'connecting' ? 'amber' : 'rose'}`;
      bridgeBadge.textContent = status === 'connected' ? 'Open' : status;
    }
  }

  updateMeshMetrics() {
    const peerCount = this.mesh.getPeerCount();
    const webrtcPeers = this.mesh.peers.size;
    const medianRtt = this.mesh.getMedianRtt();

    // Cache metrics reads from localStorage (max once per 2.5s) to avoid synchronous JSON.parse churn
    const now = Date.now();
    if (!this._cachedMetrics || (now - this._lastMetricsFetch > 2500)) {
      this._cachedMetrics = getSessionMetrics();
      this._lastMetricsFetch = now;
    }
    const metrics = this._cachedMetrics;
    const roles = this.mesh.getRoleCounts();

    const peerVal = document.getElementById('peerCountVal');
    const webrtcBadge = document.getElementById('webrtcBadge');
    if (peerVal) peerVal.textContent = webrtcPeers;
    if (webrtcBadge) webrtcBadge.textContent = `${webrtcPeers} Direct`;

    const peerDetail = document.getElementById('peerDetail');
    if (peerDetail) {
      const span = peerDetail.querySelector('span:first-child');
      if (span) span.textContent = `Direct WebRTC: ${webrtcPeers} · Bridge:`;
    }

    const rttVal = document.getElementById('rttVal');
    if (rttVal) {
      rttVal.textContent = medianRtt !== null ? medianRtt : '--';
    }

    const churnVal = document.getElementById('churnVal');
    if (churnVal) {
      churnVal.textContent = `+${metrics.peersAdded || 0} / -${metrics.peersLost || 0}`;
    }

    const rolesVal = document.getElementById('rolesVal');
    const rolesDetail = document.getElementById('rolesDetail');
    if (rolesVal) rolesVal.textContent = roles.total;
    if (rolesDetail) {
      rolesDetail.textContent = `Root: ${roles.root} · Backup: ${roles.backup}`;
    }
  }

  async updateEnvironmentUI() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const profNet = document.getElementById('profNet');
    if (profNet) {
      if (!navigator.onLine) {
        profNet.textContent = 'Offline (disconnected)';
      } else if (conn) {
        profNet.textContent = `${conn.effectiveType?.toUpperCase() || 'Online'} ${conn.downlink ? '· ' + conn.downlink + 'Mb/s' : ''}`;
      } else {
        profNet.textContent = 'Online';
      }
    }

    const profBat = document.getElementById('profBat');
    if (profBat && typeof navigator.getBattery === 'function') {
      try {
        if (!this._batteryPromise) {
          this._batteryPromise = navigator.getBattery().catch(() => null);
        }
        const b = await this._batteryPromise;
        if (b) {
          profBat.textContent = `${Math.round(b.level * 100)}% ${b.charging ? '⚡ (Charging)' : ''}`;
        } else {
          profBat.textContent = 'Unavailable';
        }
      } catch {
        profBat.textContent = 'Unavailable';
      }
    }
  }

  _scheduleRenderEventList() {
    if (this._renderDebounceTimer) return;
    this._renderDebounceTimer = setTimeout(() => {
      this._renderDebounceTimer = null;
      this._renderEventList(true);
    }, 250);
  }

  _renderEventList(force = false) {
    if (!force) {
      this._scheduleRenderEventList();
      return;
    }

    if (this._renderDebounceTimer) {
      clearTimeout(this._renderDebounceTimer);
      this._renderDebounceTimer = null;
    }

    const list = document.getElementById('eventList');
    if (!list) return;

    const events = getLocalEvents();
    const filtered = (this.currentFilter === 'all')
      ? events
      : events.filter((e) => e.category === this.currentFilter);

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 30px; font-size: 0.85rem;">No ${this.currentFilter} events recorded yet.</div>`;
      this._eventsMap.clear();
      return;
    }

    // Cap visible items to prevent unbounded DOM node accumulation (memory leak protection)
    const displayed = filtered.slice(0, this.visibleEventCount);
    const hasMore = filtered.length > this.visibleEventCount;

    // Cache visible event references for lazy JSON expansion without re-stringifying all 500 items
    this._eventsMap.clear();
    for (const ev of displayed) {
      this._eventsMap.set(String(ev.id), ev);
    }

    let html = displayed.map((ev) => {
      const timeStr = new Date(ev.ts).toLocaleTimeString();
      let badgeClass = 'cyan';
      if (ev.category === 'churn') badgeClass = 'amber';
      else if (ev.category === 'recovery') badgeClass = 'emerald';
      else if (ev.category === 'lifecycle') badgeClass = 'violet';

      const evDevice = ev.deviceName || ev.payload?.deviceName;
      const evBrowser = ev.browser || ev.payload?.browser || ev.payload?.platform?.browser;
      const isCurrentDevice = !evDevice || evDevice === this.deviceId.name;
      const localLabel = evBrowser ? `Local (${evBrowser})` : `Local (${this.platform.browser})`;
      const deviceTag = evDevice
        ? `<span class="badge-tag ${isCurrentDevice ? 'emerald' : 'cyan'}" style="font-size: 0.68rem;" title="${this._escape(evDevice)}">${isCurrentDevice ? localLabel : this._escape(evDevice)}</span>`
        : '';

      return `
        <div class="event-item" data-id="${ev.id}">
          <div class="event-item-header">
            <div class="event-item-left">
              <span class="badge-tag ${badgeClass}">${ev.category}</span>
              ${deviceTag}
              <span class="event-title">${this._escape(ev.title)}</span>
            </div>
            <span class="event-time">${timeStr}</span>
          </div>
          <div class="event-detail">${this._escape(ev.detail || '')}</div>
          <pre class="event-raw-json" id="json-${ev.id}"></pre>
        </div>
      `;
    }).join('');

    if (hasMore) {
      html += `
        <div class="timeline-footer" style="text-align: center; padding: 12px 0;">
          <button class="btn btn-sm" id="btnShowMoreEvents" style="font-size: 0.75rem; padding: 6px 14px;">
            Show More (+20) · ${filtered.length - this.visibleEventCount} remaining
          </button>
        </div>
      `;
    }

    list.innerHTML = html;
  }

  _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _startUIRefreshLoop() {
    // Fast loop for lightweight in-memory mesh metrics
    setInterval(() => {
      this.updateMeshMetrics();
    }, 2000);

    // Relaxed loop for hardware/battery IPC polling (30 seconds)
    this.updateEnvironmentUI();
    setInterval(() => {
      this.updateEnvironmentUI();
    }, 30000);
  }
}
