// src/telemetry.js — Telemetry orchestrator for heartbeats, lifecycle transitions, and churn events

import { detectPlatform, getLiveEnvironmentStats } from './id.js';
import { appendLocalEvent, updateSessionMetrics, savePreFreezeSnapshot, popPreFreezeSnapshot } from './storage.js';

export class TelemetryService {
  constructor({ mesh, lifecycle, deviceId, onTelemetryEvent }) {
    this.mesh = mesh;
    this.lifecycle = lifecycle;
    this.deviceId = deviceId;
    this.onTelemetryEvent = onTelemetryEvent || (() => {});

    this.startTime = Date.now();
    this.heartbeatInterval = null;
    this.HEARTBEAT_INTERVAL_MS = 25000; // 25s regular heartbeat

    this._bindLifecycleHooks();
    this._bindMeshHooks();
    this.startHeartbeatLoop();
  }

  startHeartbeatLoop() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      // Don't send periodic heartbeats if offline or frozen
      if (this.lifecycle.state === 'FROZEN' || this.lifecycle.state === 'OFFLINE') return;
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  async sendHeartbeat(trigger = 'periodic') {
    const platform = detectPlatform();
    const envStats = await getLiveEnvironmentStats();
    const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
    const snapshot = this.mesh.captureSnapshot();
    const roleCounts = this.mesh.getRoleCounts();

    const payload = {
      type: 'heartbeat',
      v: 1,
      trigger,
      deviceName: this.deviceId.name,
      deviceUuid: this.deviceId.uuid,
      platform: {
        os: platform.os,
        browser: platform.browser,
        isStandalone: platform.isStandalone,
        displayMode: platform.displayMode,
        hardwareConcurrency: platform.hardwareConcurrency,
        deviceMemory: platform.deviceMemory,
        onLine: envStats.network.onLine,
        effectiveType: envStats.network.effectiveType,
        downlink: envStats.network.downlink,
        rtt: envStats.network.rtt,
        batteryLevel: envStats.battery?.level ?? null,
        isCharging: envStats.battery?.charging ?? null
      },
      lifecycleState: this.lifecycle.state.toLowerCase(),
      mesh: {
        peerCount: snapshot.peerCount,
        webrtcPeers: snapshot.webrtcPeersCount,
        websocketBridge: snapshot.bridgeConnected,
        medianRttMs: snapshot.medianRtt,
        roles: {
          root: roleCounts.root,
          backup: roleCounts.backup,
          child: roleCounts.child
        }
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
      title: `Heartbeat (${trigger})`,
      detail: `${snapshot.peerCount} peers · ${snapshot.medianRtt ? snapshot.medianRtt + 'ms RTT' : 'direct'}`,
      payload
    });

    this.onTelemetryEvent('heartbeat', payload);
    await this.mesh.publishTelemetry(payload);
    return payload;
  }

  _bindLifecycleHooks() {
    // 1. On State Change
    const origStateChange = this.lifecycle.onStateChange;
    this.lifecycle.onStateChange = (newState, oldState, detail) => {
      origStateChange?.(newState, oldState, detail);
      this._handleLifecycleTransition(newState, oldState, detail);
    };

    // 2. Pre-freeze snapshot
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

      appendLocalEvent({
        category: 'lifecycle',
        title: `Pre-freeze Snapshot Saved`,
        detail: `Trigger: ${freezeDetail.trigger} · State: ${freezeDetail.stateBefore}`,
        payload: { freezeDetail, meshSnapshot: snapshot }
      });
    };

    // 3. Resume from background
    const origResume = this.lifecycle.onResume;
    this.lifecycle.onResume = async (resumeDetail) => {
      origResume?.(resumeDetail);
      await this._handleResumeAndRecovery(resumeDetail);
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
        type: 'peer_churn',
        v: 1,
        deviceName: this.deviceId.name,
        action: 'connected',
        peerNodeId: peer.id,
        transportKind: 'webrtc',
        candidateType: peer.candidateType,
        rttMs: peer.rtt,
        totalPeersNow: this.mesh.getPeerCount(),
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'churn',
        title: `Peer Joined: ${peer.id.slice(0, 8)}…`,
        detail: `Type: ${peer.candidateType} · RTT: ${peer.rtt != null ? peer.rtt + 'ms' : 'probing'}`,
        payload
      });

      this.onTelemetryEvent('peer_churn', payload);
      this.mesh.publishTelemetry(payload);
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
        type: 'peer_churn',
        v: 1,
        deviceName: this.deviceId.name,
        action: 'disconnected',
        peerNodeId: loss.id,
        transportKind: 'webrtc',
        durationMs: loss.durationMs,
        lastRttMs: loss.lastRtt,
        reason: loss.reason,
        totalPeersNow: this.mesh.getPeerCount(),
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'churn',
        title: `Peer Left: ${loss.id.slice(0, 8)}…`,
        detail: `Duration: ${Math.round(loss.durationMs / 1000)}s · Reason: ${loss.reason}`,
        payload
      });

      this.onTelemetryEvent('peer_churn', payload);
      this.mesh.publishTelemetry(payload);
    };
  }

  async _handleLifecycleTransition(newState, oldState, detail) {
    const roles = Array.from(this.mesh.activeRoles.keys());
    const payload = {
      type: 'lifecycle',
      v: 1,
      deviceName: this.deviceId.name,
      event: detail?.reason || detail?.trigger || `transition_${newState.toLowerCase()}`,
      previousState: oldState.toLowerCase(),
      newState: newState.toLowerCase(),
      activeRoles: roles,
      peerCountAtTransition: this.mesh.getPeerCount(),
      ts: Date.now()
    };

    appendLocalEvent({
      category: 'lifecycle',
      title: `State: ${oldState} ➔ ${newState}`,
      detail: detail?.reason ? `Reason: ${detail.reason}` : '',
      payload
    });

    this.onTelemetryEvent('lifecycle', payload);
    await this.mesh.publishTelemetry(payload);
  }

  async _handleResumeAndRecovery(resumeDetail) {
    const preSnapshot = popPreFreezeSnapshot();
    const sleepDurationMs = resumeDetail.sleepDurationMs || 0;

    // Trigger mesh reconnect and recovery probe
    const recoveryResult = await this.mesh.recoverFromBackground(sleepDurationMs);

    const rolesBefore = preSnapshot?.meshSnapshot?.roles?.length ?? (recoveryResult.rolesBeforeSleep || 0);
    const peersBefore = preSnapshot?.meshSnapshot?.peerCount ?? (recoveryResult.peersBeforeSleep || 0);
    const currentPeers = this.mesh.getPeerCount();
    const peersLostCount = Math.max(0, peersBefore - currentPeers);

    updateSessionMetrics((m) => ({
      ...m,
      recoveriesCount: (m.recoveriesCount || 0) + 1
    }));

    const payload = {
      type: 'recovery',
      v: 1,
      deviceName: this.deviceId.name,
      sleepDurationMs,
      socketsSurvived: recoveryResult.socketsSurvived,
      peersBeforeSleep: peersBefore,
      peersLostCount,
      rolesBeforeSleep: rolesBefore,
      rolesAfterWake: this.mesh.activeRoles.size,
      reconnectLatencyMs: recoveryResult.reconnectLatencyMs,
      recoveryDisposition: recoveryResult.socketsSurvived
        ? 'sockets_survived_sleep'
        : 'sockets_severed_reconnected_clean',
      trigger: resumeDetail.trigger,
      ts: Date.now()
    };

    appendLocalEvent({
      category: 'recovery',
      title: `Recovered from Background (${Math.round(sleepDurationMs / 1000)}s sleep)`,
      detail: `Disposition: ${payload.recoveryDisposition} · Sockets survived: ${payload.socketsSurvived}`,
      payload
    });

    this.onTelemetryEvent('recovery', payload);
    await this.mesh.publishTelemetry(payload);

    // Follow up with an immediate fresh heartbeat to re-anchor state in mesh
    setTimeout(() => {
      this.sendHeartbeat('post_recovery');
    }, 1500);
  }

  destroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
  }
}
