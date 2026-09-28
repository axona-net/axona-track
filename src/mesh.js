// src/mesh.js — Axona P2P mesh client, peer turnover observer, and role resilience manager

import { connect } from '@axona/protocol/connect.js';
import { canonicalRegion, KERNEL_VERSION } from '@axona/protocol';

export { KERNEL_VERSION };

const KNOWN_BRIDGES = {
  prod: 'wss://bridge.axona.net',
  testnet: 'wss://testnet.axona.net'
};

const DEFAULT_REGION = 'eagle';
const TELEMETRY_TOPIC = 'axona-track';

export class MeshClient {
  constructor({ onPeerAdded, onPeerLost, onPeerStats, onStatus, onMessage }) {
    this.onPeerAdded = onPeerAdded || (() => {});
    this.onPeerLost  = onPeerLost  || (() => {});
    this.onPeerStats = onPeerStats || (() => {});
    this.onStatus    = onStatus    || (() => {});
    this.onMessage   = onMessage   || (() => {});

    this.connection = null;
    this.peer = null;
    this.transport = null;
    this.author = null;
    this.nodeIdentity = null;

    this.region = this._resolveRegion();
    this.bridgeUrl = this._resolveBridgeUrl();

    // Peer tracking
    this.peers = new Map(); // peerId -> { id, state, rtt, candidateType, connectedAt, lastSeen }
    this.peerDurations = [];
    this.activeRoles = new Map(); // topic -> { nature: 'root'|'backup'|'child', enteredAt }

    // Test duty
    this.testDutyActive = false;
    this.testTopic = `axona-track/duty-${Math.random().toString(36).slice(2, 6)}`;

    this.isConnected = false;
    this.isReconnecting = false;
  }

  _resolveRegion() {
    const params = new URLSearchParams(window.location.search);
    const r = (params.get('region') || DEFAULT_REGION).toLowerCase();
    return canonicalRegion(r) || DEFAULT_REGION;
  }

  _resolveBridgeUrl() {
    const params = new URLSearchParams(window.location.search);
    const explicit = (params.get('bridge') || '').trim();
    if (/^wss?:\/\//.test(explicit)) return explicit;

    const net = (params.get('net') || '').trim().toLowerCase();
    if (KNOWN_BRIDGES[net]) return KNOWN_BRIDGES[net];

    return window.location.hostname.includes('testnet') ? KNOWN_BRIDGES.testnet : KNOWN_BRIDGES.prod;
  }

  async start() {
    this.onStatus('connecting', `Dialing ${this.bridgeUrl} [region: ${this.region}]…`);

    try {
      this.connection = await connect({
        bridge: this.bridgeUrl,
        location: { lat: 38.8951, lng: -77.0364 }, // Eagle / US-East anchor
        author: `axonatrack:author:${this.region}`, // Stable Author ID
        allowBridgeOnly: true, // Permit initial bridge-only startup while WebRTC binds
        ready: { timeoutMs: 10000 }
      });

      this.peer = this.connection.peer;
      this.transport = this.connection.transport;
      this.author = this.connection.author;
      this.nodeIdentity = this.connection.nodeIdentity;
      this.isConnected = true;

      this._wireTransportListeners();

      this.onStatus('connected', `Meshed (${this.getPeerCount()} peers) · Node: ${this.nodeIdentity.id.slice(0, 8)}…`);
      return true;
    } catch (err) {
      console.error('[axona.track] Connection error:', err);
      this.onStatus('error', `Connection error: ${err.message}`);
      return false;
    }
  }

  _wireTransportListeners() {
    if (!this.transport) return;

    // Bridge WebSocket state transitions
    if (typeof this.transport.onBridgeState === 'function') {
      this.transport.onBridgeState((state, detail) => {
        console.log(`[axona.track] Bridge state: ${state}`, detail || '');
        if (state === 'open') {
          this.isConnected = true;
          this.isReconnecting = false;
          this.onStatus('connected', `Bridge open (${this.getPeerCount()} peers)`);
        } else if (state === 'connecting') {
          this.isReconnecting = true;
          this.onStatus('connecting', 'Reconnecting to bridge…');
        } else if (state === 'disconnected') {
          this.isConnected = false;
          this.onStatus('disconnected', 'Bridge disconnected');
        }
      });
    }

    // WebRTC Mesh Manager hooks
    const webrtc = this.transport.webrtc;
    const mesh = webrtc?.mesh;

    if (mesh) {
      // 1. Mesh peer change events
      mesh.onChange((peers) => {
        this._handleMeshPeersChange(peers);
      });

      // 2. Peer lost hook
      mesh.onPeerLost((peerId) => {
        this._handlePeerLost(peerId, 'webrtc_closed');
      });

      // 3. Ping traffic hook
      mesh.onPingTraffic((peerId, kind) => {
        const p = this.peers.get(peerId);
        if (p) {
          p.lastSeen = Date.now();
          if (kind === 'recv' && typeof mesh.getLatency === 'function') {
            const lat = mesh.getLatency(peerId);
            if (typeof lat === 'number' && lat >= 0) p.rtt = lat;
          }
        }
      });
    }
  }

  _handleMeshPeersChange(peerList) {
    if (!Array.isArray(peerList)) return;
    const currentIds = new Set();
    const now = Date.now();

    for (const p of peerList) {
      const id = String(p.id || p.peerId || '');
      if (!id) continue;
      currentIds.add(id);

      if (!this.peers.has(id)) {
        // New peer connected!
        const peerData = {
          id,
          state: p.state || 'open',
          rtt: (typeof p.latency === 'number' && p.latency >= 0) ? p.latency : null,
          candidateType: p.candidateType || 'srflx',
          connectedAt: now,
          lastSeen: now
        };
        this.peers.set(id, peerData);
        this.onPeerAdded(peerData);
      } else {
        // Updated peer
        const existing = this.peers.get(id);
        existing.state = p.state || existing.state;
        if (typeof p.latency === 'number' && p.latency >= 0) existing.rtt = p.latency;
        existing.lastSeen = now;
      }
    }

    // Detect dropped peers
    for (const [id, data] of this.peers.entries()) {
      if (!currentIds.has(id)) {
        this._handlePeerLost(id, 'peer_missing_from_mesh');
      }
    }

    this._emitStats();
  }

  _handlePeerLost(peerId, reason) {
    const existing = this.peers.get(peerId);
    if (!existing) return;

    const durationMs = Date.now() - existing.connectedAt;
    this.peerDurations.push(durationMs);
    if (this.peerDurations.length > 50) this.peerDurations.shift();

    this.peers.delete(peerId);
    this.onPeerLost({
      id: peerId,
      durationMs,
      lastRtt: existing.rtt,
      reason
    });

    this._emitStats();
  }

  _emitStats() {
    this.onPeerStats({
      totalPeers: this.getPeerCount(),
      webrtcPeers: this.peers.size,
      bridgeConnected: this.isConnected,
      medianRtt: this.getMedianRtt(),
      roles: this.getRoleCounts()
    });
  }

  getPeerCount() {
    return this.peers.size + (this.isConnected ? 1 : 0);
  }

  getMedianRtt() {
    const rtts = [];
    for (const p of this.peers.values()) {
      if (typeof p.rtt === 'number' && p.rtt > 0) rtts.push(p.rtt);
    }
    if (rtts.length === 0) return null;
    rtts.sort((a, b) => a - b);
    const mid = Math.floor(rtts.length / 2);
    return rtts.length % 2 !== 0 ? rtts[mid] : Math.round((rtts[mid - 1] + rtts[mid]) / 2);
  }

  getRoleCounts() {
    let root = 0, backup = 0, child = 0;
    for (const r of this.activeRoles.values()) {
      if (r.nature === 'root') root++;
      else if (r.nature === 'backup') backup++;
      else if (r.nature === 'child') child++;
    }
    return { root, backup, child, total: this.activeRoles.size };
  }


  /**
   * Publish telemetry payload to #axona-track
   * Formatted with handle and authorClass: 'stream' for axona.chat compatibility
   */
  async publishTelemetry(payload, handle = 'axona-track') {
    if (!this.peer || !this.author) return false;
    try {
      const topicDesc = { region: this.region, name: TELEMETRY_TOPIC };
      const envelope = {
        v: 1,
        handle: payload?.deviceName || handle,
        authorClass: 'instrument',
        text: JSON.stringify(payload, null, 2),
        data: payload
      };
      await this.peer.pub(topicDesc, JSON.stringify(envelope), { signWith: this.author });
      return true;
    } catch (err) {
      console.warn('[axona.track] Telemetry publish failed:', err);
      return false;
    }
  }

  /**
   * Toggle a dummy topic role to test role survival under backgrounding
   */
  async toggleTestDuty() {
    if (!this.peer) return false;
    this.testDutyActive = !this.testDutyActive;

    const topicDesc = { region: this.region, name: this.testTopic };
    if (this.testDutyActive) {
      this.activeRoles.set(this.testTopic, { nature: 'backup', enteredAt: Date.now() });
      try {
        await this.peer.sub(topicDesc, () => {}, { since: 'all' });
        console.log(`[axona.track] Test duty armed on ${this.testTopic}`);
      } catch (err) {
        console.warn('[axona.track] Failed to arm test duty:', err);
      }
    } else {
      this.activeRoles.delete(this.testTopic);
      try {
        await this.peer.unsub?.(topicDesc);
        console.log(`[axona.track] Test duty disarmed`);
      } catch {}
    }

    this._emitStats();
    return this.testDutyActive;
  }

  /**
   * Snapshot current peer & role state for pre-freeze soft landing
   */
  captureSnapshot() {
    return {
      peerCount: this.getPeerCount(),
      webrtcPeersCount: this.peers.size,
      peerIds: Array.from(this.peers.keys()),
      bridgeConnected: this.isConnected,
      medianRtt: this.getMedianRtt(),
      roles: Array.from(this.activeRoles.entries()).map(([topic, r]) => ({ topic, ...r })),
      capturedAt: Date.now()
    };
  }

  /**
   * Reconnect after waking from background with passive pre-audit and measured latency
   */
  async recoverFromBackground(sleepDurationMs, preFreezeSnapshot = null) {
    console.log(`[axona.track] Executing post-wake recovery (sleep: ${sleepDurationMs}ms)...`);

    // 1. Passive pre-intervention observation
    const prePeerIds = new Set(preFreezeSnapshot?.meshSnapshot?.peerIds || preFreezeSnapshot?.peerIds || []);
    const immediateBridgeOpen = this.isConnected;
    const immediatePeers = Array.from(this.peers.keys());
    const survivingPeerIds = immediatePeers.filter((id) => prePeerIds.has(id));
    const sameSocketsObserved = (survivingPeerIds.length > 0);

    // 2. Measure actual reconnect latency
    const t0 = performance.now();
    if (!this.isConnected && this.transport && typeof this.transport.reconnectNow === 'function') {
      this.transport.reconnectNow();
    }

    // Wait until bridge re-establishes or up to 3000ms deadline
    const deadline = Date.now() + 3000;
    while (!this.isConnected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const measuredReconnectLatencyMs = Math.round(performance.now() - t0);

    // Allow mesh brief settling window
    await new Promise((r) => setTimeout(r, 500));

    const settledPeersCount = this.peers.size;
    const prePeersCount = prePeerIds.size;
    const peersLostCount = Math.max(0, prePeersCount - survivingPeerIds.length);

    return {
      passiveAudit: {
        bridgeOpenAtWake: immediateBridgeOpen,
        immediatePeersCount: immediatePeers.length,
        survivingPeerIds,
        continuityState: sameSocketsObserved ? 'observed_identical_ids' : 'sockets_severed_or_unknown'
      },
      reconnectLatencyMs: measuredReconnectLatencyMs,
      settledBridgeConnected: this.isConnected,
      settledPeersCount,
      prePeersCount,
      peersLostCount,
      rolesBeforeSleep: preFreezeSnapshot?.meshSnapshot?.roles?.length ?? (preFreezeSnapshot?.roles?.length || 0),
      rolesAfterWake: this.activeRoles.size
    };
  }
}
