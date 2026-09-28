// src/ui.js — UI renderer and state binding for axona.track

import { getLocalEvents, clearLocalEvents, getSessionMetrics } from './storage.js';
import { APP_VERSION, KERNEL_VERSION } from './version.js';

export class TrackUI {
  constructor({ container, deviceId, platform, mesh, lifecycle, telemetry }) {
    this.container = container;
    this.deviceId = deviceId;
    this.platform = platform;
    this.mesh = mesh;
    this.lifecycle = lifecycle;
    this.telemetry = telemetry;

    this.currentFilter = 'all';
    this.stateStartTime = Date.now();
    this.lastState = lifecycle.state;

    this._mountLayout();
    this._bindEvents();
    this._renderEventList();
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
              <span class="brand-version" id="versionBadge">v${APP_VERSION} · kernel v${KERNEL_VERSION}</span>
            </div>

            <div class="header-badges">
              <div class="pill pill-device pill-clickable" id="copyDevicePill" title="Click to copy device name">
                <span class="status-dot connected"></span>
                <span id="deviceNameLabel">${this.deviceId.name}</span>
              </div>
              <div class="pill pill-pwa">
                <span>${this.platform.isStandalone ? '📱 Standalone PWA' : '🌐 Browser Tab'}</span>
              </div>
              <div class="pill pill-region">
                <span id="regionLabel">${this.mesh.region}</span>
              </div>
              <div class="pill" id="bridgeStatusPill">
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
              <span>Active Peers</span>
              <span class="badge-tag cyan" id="webrtcBadge">0 WebRTC</span>
            </div>
            <div class="metric-value">
              <span id="peerCountVal">0</span>
              <span class="metric-unit">nodes</span>
            </div>
            <div class="metric-detail" id="peerDetail">
              <span>Bridge:</span> <span class="badge-tag emerald" id="bridgeBadge">Connecting</span>
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
        this._renderEventList();
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
        this._renderEventList();
      });
    });
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
    if (state === 'ACTIVE') desc = 'Foreground active · full fidelity';
    else if (state === 'PASSIVE') desc = 'Visible but unfocused';
    else if (state === 'HIDDEN') desc = 'Tab hidden · pre-freeze snapshot preserved';
    else if (state === 'FROZEN') desc = 'OS execution suspended · zero CPU';
    else if (state === 'RESUMED') desc = `Post-wake recovery · sleep: ${Math.round((detail?.sleepDurationMs || 0) / 1000)}s`;
    else if (state === 'OFFLINE') desc = 'Network interface disconnected';

    if (subtext) subtext.textContent = desc;
    this._renderEventList();
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
    const metrics = getSessionMetrics();
    const roles = this.mesh.getRoleCounts();

    const peerVal = document.getElementById('peerCountVal');
    const webrtcBadge = document.getElementById('webrtcBadge');
    if (peerVal) peerVal.textContent = peerCount;
    if (webrtcBadge) webrtcBadge.textContent = `${webrtcPeers} WebRTC`;

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
        const b = await navigator.getBattery();
        profBat.textContent = `${Math.round(b.level * 100)}% ${b.charging ? '⚡ (Charging)' : ''}`;
      } catch {
        profBat.textContent = 'Unavailable';
      }
    }
  }

  _renderEventList() {
    const list = document.getElementById('eventList');
    if (!list) return;

    const events = getLocalEvents();
    const filtered = (this.currentFilter === 'all')
      ? events
      : events.filter((e) => e.category === this.currentFilter);

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 30px; font-size: 0.85rem;">No ${this.currentFilter} events recorded yet.</div>`;
      return;
    }

    list.innerHTML = filtered.map((ev) => {
      const timeStr = new Date(ev.ts).toLocaleTimeString();
      let badgeClass = 'cyan';
      if (ev.category === 'churn') badgeClass = 'amber';
      else if (ev.category === 'recovery') badgeClass = 'emerald';
      else if (ev.category === 'lifecycle') badgeClass = 'violet';

      return `
        <div class="event-item" data-id="${ev.id}">
          <div class="event-item-header">
            <div class="event-item-left">
              <span class="badge-tag ${badgeClass}">${ev.category}</span>
              <span class="event-title">${this._escape(ev.title)}</span>
            </div>
            <span class="event-time">${timeStr}</span>
          </div>
          <div class="event-detail">${this._escape(ev.detail || '')}</div>
          <pre class="event-raw-json" id="json-${ev.id}">${this._escape(JSON.stringify(ev.payload || {}, null, 2))}</pre>
        </div>
      `;
    }).join('');

    // Bind click to toggle JSON expansion
    list.querySelectorAll('.event-item').forEach((item) => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        const jsonEl = document.getElementById(`json-${id}`);
        if (jsonEl) {
          jsonEl.classList.toggle('expanded');
        }
      });
    });
  }

  _escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  _startUIRefreshLoop() {
    // Fast loop for metrics and network updates
    setInterval(() => {
      this.updateMeshMetrics();
      this.updateEnvironmentUI();
    }, 2000);
  }
}
