// src/telemetry.js — Telemetry orchestrator for state transitions, offline event holding, and recovery flush

import { detectPlatform, getLiveEnvironmentStats, getDeviceTypeDesc } from './id.js';
import { 
  appendLocalEvent, 
  updateSessionMetrics, 
  savePreFreezeSnapshot, 
  popPreFreezeSnapshot,
  queueOfflineEvent,
  getOfflineOutbox,
  ackOfflineOutbox,
  clearOfflineOutbox,
  withFlushLock,
  withStorageTransaction
} from './storage.js';
import { APP_VERSION, KERNEL_VERSION } from './version.js';

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

    const isPeriodic = trigger === 'periodic_30m';
    const payload = {
      note: `Heartbeat (${trigger}): ${snapshot.webrtcPeersCount} direct WebRTC + ${snapshot.bridgeConnected ? '1 bridge' : '0 bridge'} (total ${snapshot.peerCount}) · uptime ${Math.round(uptimeSec / 60)}m`,
      v: 1,
      appVersion: APP_VERSION,
      kernelVersion: KERNEL_VERSION,
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
      title: isPeriodic ? `30m Anchor Heartbeat` : `Manual Heartbeat Pulse`,
      detail: `${snapshot.webrtcPeersCount} direct WebRTC · ${snapshot.bridgeConnected ? 'Bridge open' : 'Bridge disconnected'} · ${snapshot.medianRtt != null ? snapshot.medianRtt + 'ms RTT' : 'RTT unknown'}`,
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
    this.lifecycle.onStateChange = async (newState, oldState, detail) => {
      origStateChange?.(newState, oldState, detail);
      await this._handleLifecycleTransition(newState, oldState, detail);
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

      const dev = getDeviceTypeDesc();
      const eventRecord = {
        note: `${dev.sleepIcon} ${dev.noun} sleeping: ${this.deviceId.name} (suspended with ${snapshot.peerCount} peers, trigger: ${freezeDetail.trigger})`,
        type: 'state_transition',
        event: 'pre_freeze_snapshot',
        trigger: freezeDetail.trigger,
        stateBefore: freezeDetail.stateBefore,
        peersHeld: snapshot.peerCount,
        rolesHeld: snapshot.roles.length,
        deviceName: this.deviceId.name,
        deviceType: dev.noun,
        ts: Date.now()
      };

      appendLocalEvent({
        category: 'lifecycle',
        title: `${dev.sleepIcon} ${dev.noun} sleeping`,
        detail: `Suspended with ${snapshot.peerCount} peers (${freezeDetail.trigger})`,
        deviceName: this.deviceId.name,
        payload: eventRecord
      });

      // Hold in offline outbox while hidden/frozen as fallback
      queueOfflineEvent(eventRecord);

      // Attempt immediate live publish over open bridge before OS suspends
      if (this.mesh.isConnected) {
        this.mesh.publishTelemetry(eventRecord).catch((err) => {
          console.warn('[axona.track] Live pre-freeze publish attempt missed:', err.message);
        });
      }
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
        note: `Peer Connected: ${peer.id.slice(0, 8)}… via ${peer.candidateType || 'webrtc'} (total ${this.mesh.getPeerCount()} peers)`,
        v: 1,
        appVersion: APP_VERSION,
        kernelVersion: KERNEL_VERSION,
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
        detail: `Type: ${peer.candidateType || 'unreported'} · RTT: ${peer.rtt != null ? peer.rtt + 'ms' : 'unknown'}`,
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
        note: `Peer Dropped: ${loss.id.slice(0, 8)}… after ${Math.round(loss.durationMs / 1000)}s (${loss.reason})`,
        v: 1,
        appVersion: APP_VERSION,
        kernelVersion: KERNEL_VERSION,
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
      note: `Connectivity Warning: ${warnDetail.reason} (${this.mesh.getPeerCount()} peers, state ${this.lifecycle.state})`,
      v: 1,
      appVersion: APP_VERSION,
      kernelVersion: KERNEL_VERSION,
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
      note: `State Transition: ${oldState} ➔ ${newState}${detail?.reason ? ` (${detail.reason})` : ''}`,
      v: 1,
      appVersion: APP_VERSION,
      kernelVersion: KERNEL_VERSION,
      type: 'lifecycle_transition',
      deviceName: this.deviceId.name,
      previousState: oldState.toLowerCase(),
      newState: newState.toLowerCase(),
      reason: detail?.reason || detail?.trigger || 'transition',
      activeRolesCount: roles.length,
      peerCountAtTransition: this.mesh.getPeerCount(),
      ts: Date.now()
    };

    try {
      await appendLocalEvent({
        category: 'lifecycle',
        title: `State Transition: ${oldState} ➔ ${newState}`,
        detail: detail?.reason ? `Trigger: ${detail.reason} (Now ${newState})` : `Now ${newState}`,
        deviceName: this.deviceId.name,
        payload
      });
      this.onTelemetryEvent('lifecycle', payload);
    } catch (err) {
      console.error('[axona.track] Failed to persist lifecycle event:', err);
    }

    // If entering hidden, frozen, or offline, queue to offline outbox
    if (newState === 'HIDDEN' || newState === 'FROZEN' || newState === 'OFFLINE') {
      queueOfflineEvent(payload);
    } else if ((newState === 'ACTIVE' || newState === 'PASSIVE') && this.mesh.isConnected) {
      this.mesh.publishTelemetry(payload);
    }
  }

  async _handleResumeAndFlush(resumeDetail) {
    if (this._isFlushing) return;
    this._isFlushing = true;

    try {
      const observedIntervalMs = resumeDetail.observedIntervalMs || resumeDetail.sleepDurationMs || 0;
      const preSnapshot = popPreFreezeSnapshot();

      // 1. Trigger mesh reconnect and recovery probe with preSnapshot
      const recoveryResult = await this.mesh.recoverFromBackground(observedIntervalMs, preSnapshot);

      updateSessionMetrics((m) => ({
        ...m,
        recoveriesCount: (m.recoveriesCount || 0) + 1
      }));

      // Flush routine executed under exclusive flush lock once bridge is open
      const doFlush = async () => {
        return withFlushLock(async () => {
          if (!this.mesh.isConnected) return false;

          const prePeers = preSnapshot?.meshSnapshot?.peerCount ?? recoveryResult.prePeersCount;
          const currentPeers = this.mesh.getPeerCount();
          const heldEvents = getOfflineOutbox();
          const heldIds = heldEvents.map((e) => e.id);

          // A. Publish human-readable wake announcement to #axona-track
          const dev = getDeviceTypeDesc();
          const wakePayload = {
            note: `${dev.wakeIcon} ${dev.noun} woke up: ${this.deviceId.name} (resumed after ${Math.round(observedIntervalMs / 1000)}s sleep, restored ${currentPeers} peers)`,
            v: 1,
            appVersion: APP_VERSION,
            kernelVersion: KERNEL_VERSION,
            type: 'lifecycle_transition',
            event: 'wake_resume',
            deviceName: this.deviceId.name,
            deviceType: dev.noun,
            sleepIntervalMs: observedIntervalMs,
            peersBeforeSleep: prePeers,
            peersAfterWake: currentPeers,
            ts: Date.now()
          };

          appendLocalEvent({
            category: 'lifecycle',
            title: `${dev.wakeIcon} ${dev.noun} woke up`,
            detail: `Resumed after ${Math.round(observedIntervalMs / 1000)}s sleep (${currentPeers} peers)`,
            deviceName: this.deviceId.name,
            payload: wakePayload
          });

          await this.mesh.publishTelemetry(wakePayload);

          // B. Publish any offline events that were held while sleeping (e.g. sleep event if not sent live)
          for (const ev of heldEvents) {
            if (ev.type === 'state_transition' || ev.event === 'pre_freeze_snapshot') {
              await this.mesh.publishTelemetry({
                ...ev,
                v: 1,
                deviceName: this.deviceId.name
              });
            }
          }

          // C. Sanitize held events to prevent recursive payload bloating
          const sanitizedHeld = heldEvents
            .filter((e) => e.type !== 'recovery_journal_flush')
            .map((e) => ({
              id: e.id,
              ts: e.ts,
              type: e.type,
              note: e.note || e.title || ''
            }));

          const recoveryPayload = {
            note: `Wake Recovery Audit: Reconnected after ${Math.round(observedIntervalMs / 1000)}s (${recoveryResult.waitOutcome}, ${recoveryResult.reconnectWaitElapsedMs}ms)`,
            v: 1,
            appVersion: APP_VERSION,
            kernelVersion: KERNEL_VERSION,
            type: 'recovery_journal_flush',
            deviceName: this.deviceId.name,
            flushState: 'settled',
            summary: `Tab restored after ${Math.round(observedIntervalMs / 1000)}s interval. Flushed ${heldEvents.length} held events.`,
            recovery: {
              observedIntervalMs,
              passiveAudit: recoveryResult.passiveAudit,
              reconnectWaitElapsedMs: recoveryResult.reconnectWaitElapsedMs,
              waitOutcome: recoveryResult.waitOutcome,
              settledBridgeConnected: recoveryResult.settledBridgeConnected,
              peersBeforeSleep: prePeers,
              peersAfterWake: currentPeers,
              peersLostCount: recoveryResult.peersLostCount,
              trigger: resumeDetail.trigger
            },
            heldOfflineEventsCount: sanitizedHeld.length,
            heldOfflineEvents: sanitizedHeld,
            ts: Date.now()
          };

          this.onTelemetryEvent('recovery', recoveryPayload);

          const ok = await this.mesh.publishTelemetry(recoveryPayload);
          if (ok) {
            await ackOfflineOutbox(heldIds);
            appendLocalEvent({
              category: 'recovery',
              title: `Wake Recovery Flushed (${Math.round(observedIntervalMs / 1000)}s sleep)`,
              detail: `Flushed ${heldIds.length} events · ${recoveryResult.waitOutcome} (${recoveryResult.reconnectWaitElapsedMs}ms)`,
              deviceName: this.deviceId.name,
              payload: recoveryPayload
            });
            console.log(`[axona.track] Successfully published recovery flush and acked ${heldIds.length} held events.`);
            return true;
          } else {
            console.warn('[axona.track] Recovery flush publish unconfirmed; retaining in outbox for bridge reconnect retry.');
            return false;
          }
        });
      };

      // Try immediate flush if already connected
      let flushed = false;
      if (this.mesh.isConnected) {
        const res = await doFlush();
        flushed = !!(res && res.result);
      }

      // If mobile radio is still re-associating, arm bridge reconnect listener and retry timers
      if (!flushed) {
        console.log('[axona.track] Waiting for mobile radio / bridge reconnect to flush wake events…');
        const unbindBridge = this.mesh.onBridgeOpen(async () => {
          unbindBridge();
          await doFlush();
        });

        // Additional safety retry intervals for mobile browsers
        setTimeout(async () => {
          if (this.mesh.isConnected && getOfflineOutbox().length > 0) {
            await doFlush();
          }
        }, 3500);

        setTimeout(async () => {
          if (this.mesh.isConnected && getOfflineOutbox().length > 0) {
            await doFlush();
          }
        }, 7000);
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
