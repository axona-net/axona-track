// src/telemetry.js — Telemetry orchestrator for state transitions, offline event holding, and recovery flush

import { detectPlatform, getLiveEnvironmentStats } from './id.js';
import { 
  appendLocalEvent, 
  updateSessionMetrics, 
  savePreFreezeSnapshot, 
  popPreFreezeSnapshot,
  queueOfflineEvent,
  getOfflineOutbox,
  clearOfflineOutbox
} from './storage.js';

export class TelemetryService {
  constructor({ mesh, lifecycle, deviceId, onTelemetryEvent }) {
    this.mesh = mesh;
    this.lifecycle = lifecycle;
    this.deviceId = deviceId;
    this.onTelemetryEvent = onTelemetryEvent || (() => {});

    this.startTime = Date.now();
    this.heartbeatInterval = null;
    this.HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30-minute anchor heartbeat per David directive

    this._bindLifecycleHooks();
    this._bindMeshHooks();
    this.startHeartbeatLoop();
  }

  startHeartbeatLoop() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      // Only emit periodic heartbeat if tab is fully active/visible and meshed
      if (this.lifecycle.state !== 'ACTIVE' || !this.mesh.isConnected) return;
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  async sendHeartbeat(trigger = 'periodic_30m') {
    const platform = detectPlatform();
    const envStats = await getLiveEnvironmentStats();
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
    const snapshot = this.mesh.captureSnapshot();
    const roleCounts = this.mesh.getRoleCounts();

    const payload = {
      v: 1,
      type: 'heartbeat_anchor',
      trigger,
      deviceName: this.deviceId.name,
      platform: {
        os: platform.os,
        browser: platform.browser,
        isStandalone: platform.isStandalone,
        displayMode: platform.displayMode,
        onLine: envStats.network.onLine,
        effectiveType: envStats.network.effectiveType
      },
      lifecycleState: this.lifecycle.state.toLowerCase(),
      mesh: {
        peerCount: snapshot.peerCount,
        webrtcPeers: snapshot.webrtcPeersCount,
        websocketBridge: snapshot.bridgeConnected,
        medianRttMs: snapshot.medianRtt,
        roles: roleCounts
      },
      uptimeSec,
      ts: Date.now()
    };

    updateSessionMetrics((m) => ({
      ...m,
      heartbeatsSent: (m.heartbeatsSent || 0) + 1
    }));

    appendLocalEvent({
      category: 'heartbeat',
      title: `30m Anchor Heartbeat`,
      detail: `${snapshot.peerCount} peers · ${snapshot.medianRtt ? snapshot.medianRtt + 'ms RTT' : 'direct'}`,
      payload
    });

    this.onTelemetryEvent('heartbeat', payload);
    await this.mesh.publishTelemetry(payload);
    return payload;
  }

  _bindLifecycleHooks() {
    // 1. Connectivity Warning (e.g. tab hidden imminent freeze, or network RTT degradation)
    const origWarning = this.lifecycle.onConnectivityWarning;
    this.lifecycle.onConnectivityWarning = (warnDetail) => {
      origWarning?.(warnDetail);
      this._handleConnectivityWarning(warnDetail);
    };

    // 2. On State Change (ACTIVE -> HIDDEN -> FROZEN -> RESUMED -> OFFLINE)
    const origStateChange = this.lifecycle.onStateChange;
    this.lifecycle.onStateChange = (newState, oldState, detail) => {
      origStateChange?.(newState, oldState, detail);
      this._handleLifecycleTransition(newState, oldState, detail);
    };

    // 3. Pre-freeze snapshot (called upon hidden or freeze)
    const origPreFreeze = this.lifecycle.onPreFreeze;
    this.lifecycle.onPreFreeze = (freezeDetail) => {
      origPreFreeze?.(freezeDetail);
      const snapshot = this.mesh.captureSnapshot();
      savePreFreezeSnapshot({
        ...freezeDetail,
        meshSnapshot: snapshot
      });

      updateSessionMetrics((m) => ({
        ...m,
        suspensionsCount: (m.suspensionsCount || 0) + 1
      }));

      const eventRecord = {
        type: 'state_transition',
        event: 'pre_freeze_snapshot',
        trigger: freezeDetail.trigger,
        stateBefore: freezeDetail.stateBefore,
        peersHeld: snapshot.peerCount,
        rolesHeld: snapshot.roles.length,
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'lifecycle',
        title: `Pre-freeze Snapshot Saved`,
        detail: `Trigger: ${freezeDetail.trigger} · Peers: ${snapshot.peerCount} · Roles: ${snapshot.roles.length}`,
        payload: eventRecord
      });

      // Hold in offline outbox while hidden/frozen
      queueOfflineEvent(eventRecord);
    };

    // 4. Resume & Recovery from background
    const origResume = this.lifecycle.onResume;
    this.lifecycle.onResume = async (resumeDetail) => {
      origResume?.(resumeDetail);
      await this._handleResumeAndFlush(resumeDetail);
    };
  }

  _bindMeshHooks() {
    // Peer added
    const origPeerAdded = this.mesh.onPeerAdded;
    this.mesh.onPeerAdded = (peer) => {
      origPeerAdded?.(peer);

      updateSessionMetrics((m) => ({
        ...m,
        peersAdded: (m.peersAdded || 0) + 1
      }));

      const payload = {
        v: 1,
        type: 'peer_connected',
        deviceName: this.deviceId.name,
        peerNodeId: peer.id,
        transportKind: 'webrtc',
        candidateType: peer.candidateType,
        rttMs: peer.rtt,
        totalPeersNow: this.mesh.getPeerCount(),
        lifecycleState: this.lifecycle.state.toLowerCase(),
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'churn',
        title: `Peer Connected: ${peer.id.slice(0, 8)}…`,
        detail: `Type: ${peer.candidateType} · RTT: ${peer.rtt != null ? peer.rtt + 'ms' : 'probing'}`,
        payload
      });

      this.onTelemetryEvent('peer_churn', payload);

      // If tab is hidden or offline, queue to outbox; otherwise publish live
      if (this.lifecycle.state === 'HIDDEN' || this.lifecycle.state === 'FROZEN' || !this.mesh.isConnected) {
        queueOfflineEvent(payload);
      } else {
        this.mesh.publishTelemetry(payload);
      }
    };

    // Peer lost
    const origPeerLost = this.mesh.onPeerLost;
    this.mesh.onPeerLost = (loss) => {
      origPeerLost?.(loss);

      updateSessionMetrics((m) => ({
        ...m,
        peersLost: (m.peersLost || 0) + 1
      }));

      const payload = {
        v: 1,
        type: 'peer_disconnected',
        deviceName: this.deviceId.name,
        peerNodeId: loss.id,
        transportKind: 'webrtc',
        durationMs: loss.durationMs,
        lastRttMs: loss.lastRtt,
        reason: loss.reason,
        totalPeersNow: this.mesh.getPeerCount(),
        lifecycleState: this.lifecycle.state.toLowerCase(),
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'churn',
        title: `Peer Dropped: ${loss.id.slice(0, 8)}…`,
        detail: `Duration: ${Math.round(loss.durationMs / 1000)}s · Reason: ${loss.reason}`,
        payload
      });

      this.onTelemetryEvent('peer_churn', payload);

      // If tab is hidden or offline, queue to outbox; otherwise publish live
      if (this.lifecycle.state === 'HIDDEN' || this.lifecycle.state === 'FROZEN' || !this.mesh.isConnected) {
        queueOfflineEvent(payload);
      } else {
        this.mesh.publishTelemetry(payload);
      }
    };
  }

  _handleConnectivityWarning(warnDetail) {
    const payload = {
      v: 1,
      type: 'connectivity_warning',
      deviceName: this.deviceId.name,
      reason: warnDetail.reason,
      details: warnDetail,
      lifecycleState: this.lifecycle.state.toLowerCase(),
      peerCount: this.mesh.getPeerCount(),
      ts: Date.now()
    };

    appendLocalEvent({
      category: 'lifecycle',
      title: `Connectivity Warning: ${warnDetail.reason}`,
      detail: `Peers: ${this.mesh.getPeerCount()} · State: ${this.lifecycle.state}`,
      payload
    });

    this.onTelemetryEvent('lifecycle', payload);

    if (this.lifecycle.state === 'HIDDEN' || this.lifecycle.state === 'FROZEN' || !this.mesh.isConnected) {
      queueOfflineEvent(payload);
    } else {
      this.mesh.publishTelemetry(payload);
    }
  }

  async _handleLifecycleTransition(newState, oldState, detail) {
    const roles = Array.from(this.mesh.activeRoles.keys());
    const payload = {
      v: 1,
      type: 'lifecycle_transition',
      deviceName: this.deviceId.name,
      previousState: oldState.toLowerCase(),
      newState: newState.toLowerCase(),
      reason: detail?.reason || detail?.trigger || 'transition',
      activeRolesCount: roles.length,
      peerCountAtTransition: this.mesh.getPeerCount(),
      ts: Date.now()
    };

    appendLocalEvent({
      category: 'lifecycle',
      title: `State Transition: ${oldState} ➔ ${newState}`,
      detail: detail?.reason ? `Reason: ${detail.reason}` : '',
      payload
    });

    this.onTelemetryEvent('lifecycle', payload);

    // If entering hidden, frozen, or offline, queue to offline outbox
    if (newState === 'HIDDEN' || newState === 'FROZEN' || newState === 'OFFLINE') {
      queueOfflineEvent(payload);
    } else if (newState === 'ACTIVE' && this.mesh.isConnected) {
      this.mesh.publishTelemetry(payload);
    }
  }

  async _handleResumeAndFlush(resumeDetail) {
    if (this._isFlushing) return;
    this._isFlushing = true;

    try {
      const preSnapshot = popPreFreezeSnapshot();
      const sleepDurationMs = resumeDetail.sleepDurationMs || 0;

      // 1. Trigger mesh reconnect and recovery probe with preSnapshot
      const recoveryResult = await this.mesh.recoverFromBackground(sleepDurationMs, preSnapshot);

      const rolesBefore = preSnapshot?.meshSnapshot?.roles?.length ?? (recoveryResult.rolesBeforeSleep || 0);
      const prePeers = preSnapshot?.meshSnapshot?.peerCount ?? recoveryResult.prePeersCount;
      const currentPeers = this.mesh.getPeerCount();
      const peersLostCount = recoveryResult.peersLostCount;

      updateSessionMetrics((m) => ({
        ...m,
        recoveriesCount: (m.recoveriesCount || 0) + 1
      }));

      // 2. Collect current offline outbox batch without clearing yet
      const heldEvents = getOfflineOutbox();
      const heldIds = heldEvents.map((e) => e.id);

      const payload = {
        v: 1,
        type: 'recovery_journal_flush',
        deviceName: this.deviceId.name,
        summary: `Tab restored after ${Math.round(sleepDurationMs / 1000)}s sleep. Flushed ${heldEvents.length} held events.`,
        recovery: {
          sleepDurationMs,
          passiveAudit: recoveryResult.passiveAudit,
          reconnectLatencyMs: recoveryResult.reconnectLatencyMs,
          settledBridgeConnected: recoveryResult.settledBridgeConnected,
          peersBeforeSleep: prePeers,
          peersAfterWake: currentPeers,
          peersLostCount,
          rolesBeforeSleep: rolesBefore,
          rolesAfterWake: this.mesh.activeRoles.size,
          trigger: resumeDetail.trigger
        },
        heldOfflineEventsCount: heldEvents.length,
        heldOfflineEvents: heldEvents,
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'recovery',
        title: `Wake Recovery & Offline Journal Flush (${Math.round(sleepDurationMs / 1000)}s sleep)`,
        detail: `Continuity: ${recoveryResult.passiveAudit.continuityState} · Reconnect: ${recoveryResult.reconnectLatencyMs}ms · Held Events: ${heldEvents.length}`,
        payload
      });

      this.onTelemetryEvent('recovery', payload);

      // Wait for transport to settle before attempting publish
      let attempts = 0;
      while (!this.mesh.isConnected && attempts < 10) {
        await new Promise((r) => setTimeout(r, 300));
        attempts++;
      }

      // 3. Publish and only ACK/clear the flushed IDs upon confirmed success
      const ok = await this.mesh.publishTelemetry(payload);
      if (ok) {
        ackOfflineOutbox(heldIds);
        console.log(`[axona.track] Successfully published recovery flush and acked ${heldIds.length} held events.`);
      } else {
        console.warn(`[axona.track] Recovery flush publish unconfirmed; retaining ${heldIds.length} events in outbox for subsequent retry.`);
      }
    } catch (err) {
      console.error('[axona.track] Error during resume and flush:', err);
    } finally {
      this._isFlushing = false;
    }
  }

  destroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  }
}
