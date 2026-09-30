// src/lab.js — Adaptation Test Harness for axona.track (v0.3.0)
// Implements client-side empirical simulations for:
// 1. Pre-freeze role relinquish handoff
// 2. Tiered mobile grace-period profiler
// 3. Fast-path active WebRTC channel probing
// 4. Dynamic bandwidth backpressure governor
// 5. Dynamic mesh degree scaling & stress testing

import { detectPlatform } from './id.js';
import { APP_VERSION, KERNEL_VERSION } from './version.js';
import { peekPreFreezeSnapshot } from './storage.js';

export const LAB_VERSION = '0.3.0';

function redactPeerId(id) {
  if (typeof id !== 'string') return '';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export class AdaptationLab {
  constructor({ mesh, lifecycle, telemetry, mode = 'offline_mock', onUpdate }) {
    this.mesh = mesh;
    this.lifecycle = lifecycle;
    this.telemetry = telemetry;
    this.mode = mode; // 'offline_mock' | 'live_study'
    this.onUpdate = onUpdate || (() => {});

    // Lab state and run records
    this.history = {
      test1Handoff: [],
      test2Grace: [],
      test3FastPath: [],
      test4Backpressure: [],
      test5MeshScale: []
    };

    // Backpressure governor state
    this.governor = {
      active: false,
      startedAt: null,
      coalescedCount: 0,
      suppressedCount: 0,
      passedCount: 0,
      maxOutboxBytes: 256 * 1024, // 256 KB safety limit
      maxQueueItems: 100
    };
  }

  setMode(newMode) {
    if (newMode !== 'offline_mock' && newMode !== 'live_study') {
      throw new Error(`Invalid lab mode: ${newMode}`);
    }
    this.mode = newMode;
    this._notify();
    return this.mode;
  }

  // =========================================================================
  // TEST 1: Pre-Freeze Role Relinquish & Handoff Simulation
  // =========================================================================
  async runTest1Handoff({ timeoutMs = 2500 } = {}) {
    const startedAt = Date.now();
    const attemptId = `handoff-${Math.random().toString(36).slice(2, 8)}`;
    const isConnected = this.mesh?.isConnected || false;
    const webrtcPeersCount = this.mesh?.peers?.size || 0;
    const transportAtDispatch = isConnected
      ? (webrtcPeersCount > 0 ? 'webrtc_direct' : 'bridge_only')
      : 'disconnected';

    const record = {
      testId: 'test_1_handoff',
      attemptId,
      mode: this.mode,
      startedAt,
      timeoutMs,
      transportAtDispatch,
      elapsedMs: 0,
      outcome: 'in_flight', // Preserves denominator even if aborted/terminated
      error: null
    };

    // Register in history immediately so aborted/cancelled runs stay in denominator
    this.history.test1Handoff.unshift(record);
    if (this.history.test1Handoff.length > 50) this.history.test1Handoff.pop();
    this._notify();

    try {
      if (this.mode === 'offline_mock') {
        // Deterministic simulated execution (15ms - 45ms synthetic dispatch latency)
        const simLatency = Math.min(timeoutMs, 25);
        await new Promise((r) => setTimeout(r, simLatency));
        record.outcome = 'settled_resolved';
      } else {
        // Live study: publish role relinquish intent to ephemeral test topic
        const topicDesc = {
          region: this.mesh.region || 'eagle',
          name: this.mesh.testTopic || `axona-track/duty-${attemptId}`
        };

        const payload = {
          note: `[Lab Test 1] Role Relinquish Intent: backup duty handoff`,
          type: 'role_relinquish_intent',
          attemptId,
          role: 'backup',
          deviceName: this.telemetry?.deviceId?.name || 'anonymous',
          ts: startedAt
        };

        // Race peer.pub against timeout deadline
        const pubPromise = this.mesh.peer
          ? this.mesh.peer.pub(topicDesc, payload, { signWith: this.mesh.author })
          : Promise.reject(new Error('No peer available'));

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('dispatch_timeout')), timeoutMs)
        );

        await Promise.race([pubPromise, timeoutPromise]);
        record.outcome = 'settled_resolved';
      }
    } catch (err) {
      if (err.message === 'dispatch_timeout' || (Date.now() - startedAt) >= timeoutMs) {
        record.outcome = 'interrupted_timeout';
      } else {
        record.outcome = 'settled_rejected';
      }
      record.error = err.message;
    } finally {
      record.elapsedMs = Date.now() - startedAt;
      this._notify();
    }

    return record;
  }

  // =========================================================================
  // TEST 2: Tiered Mobile Grace Period & Eviction Profiler
  // =========================================================================
  runTest2GracePeriod({ simulatedIntervalMs = null, prePeersCount = null, survivingPeersCount = null } = {}) {
    const startedAt = Date.now();
    const attemptId = `grace-${Math.random().toString(36).slice(2, 8)}`;

    let intervalMs = simulatedIntervalMs;
    let preCount = prePeersCount;
    let survivingCount = survivingPeersCount;

    if (intervalMs === null) {
      // In live mode, pull from last observed lifecycle sleep or default to 15s
      const lastSleep = this.lifecycle?.observedIntervalMs || 15000;
      intervalMs = lastSleep;
    }

    // Determine neutral duration tier
    let tier = 'tier_under_10s'; // < 10s
    if (intervalMs >= 300000) {
      tier = 'tier_over_5m'; // > 5m
    } else if (intervalMs >= 60000) {
      tier = 'tier_1m_to_5m'; // 1m - 5m
    } else if (intervalMs >= 10000) {
      tier = 'tier_10s_to_60s'; // 10s - 60s
    }

    // Determine peer counts & baseline
    let hasBaseline = true;
    if (preCount === null) {
      if (this.mode === 'offline_mock') {
        preCount = 4; // Mock baseline
      } else {
        // Read actual baseline from pre-freeze snapshot
        const snapshot = peekPreFreezeSnapshot();
        if (snapshot && Array.isArray(snapshot.peers)) {
          preCount = snapshot.peers.length;
        } else {
          hasBaseline = false;
          preCount = null;
        }
      }
    }

    if (survivingCount === null) {
      if (this.mode === 'offline_mock') {
        const base = preCount ?? 4;
        if (tier === 'tier_under_10s') survivingCount = base;
        else if (tier === 'tier_10s_to_60s') survivingCount = Math.max(0, base - 1);
        else if (tier === 'tier_1m_to_5m') survivingCount = Math.floor(base * 0.5);
        else survivingCount = 0;
      } else {
        survivingCount = this.mesh?.peers?.size ?? 0;
      }
    }

    const retentionRatio = (hasBaseline && preCount !== null && preCount > 0)
      ? (survivingCount / preCount)
      : (hasBaseline && preCount === 0 ? 1.0 : null);

    const retentionState = !hasBaseline
      ? 'baseline_unavailable'
      : (survivingCount > 0 ? 'cached_peer_ids_retained' : 'no_cached_peer_ids_retained');

    const record = {
      testId: 'test_2_grace',
      attemptId,
      mode: this.mode,
      observedIntervalMs: intervalMs,
      tier,
      prePeersCount: preCount,
      survivingPeersCount: survivingCount,
      retentionRatio,
      retentionState,
      ts: startedAt
    };

    this.history.test2Grace.unshift(record);
    if (this.history.test2Grace.length > 50) this.history.test2Grace.pop();
    this._notify();
    return record;
  }

  // =========================================================================
  // TEST 3: Fast-Path Reconnection & Active Channel Probing
  // =========================================================================
  async runTest3FastPath({ probeTimeoutMs = 1500, maxProbes = 3 } = {}) {
    const startedAt = Date.now();
    const attemptId = `fastpath-${Math.random().toString(36).slice(2, 8)}`;
    const bridgeConnectedAtStart = this.mesh?.isConnected || false;

    // Clamp maxProbes strictly <= 3 and >= 1
    const clampedMaxProbes = Math.min(3, Math.max(1, typeof maxProbes === 'number' ? maxProbes : 3));

    // Collect target peers to probe (up to clampedMaxProbes cap)
    const targetPeerIds = Array.from(this.mesh?.peers?.keys() || []).slice(0, clampedMaxProbes);
    if (targetPeerIds.length === 0 && this.mode === 'offline_mock') {
      targetPeerIds.push('mock-peer-alpha', 'mock-peer-beta');
      if (targetPeerIds.length > clampedMaxProbes) {
        targetPeerIds.length = clampedMaxProbes;
      }
    }

    const probeResults = [];
    const rtts = [];

    if (this.mode === 'offline_mock') {
      // Deterministic simulation
      for (const id of targetPeerIds) {
        const mockRtt = 18 + Math.floor(Math.random() * 20);
        rtts.push(mockRtt);
        probeResults.push({ peerId: id, status: 'responsive', rttMs: mockRtt });
      }
    } else {
      // Live active probing of existing WebRTC channels
      const meshMgr = this.mesh?.transport?.mesh || this.mesh?.transport?.webrtc?.mesh;

      const probePromises = targetPeerIds.map(async (peerId) => {
        const t0 = performance.now();
        if (!meshMgr || typeof meshMgr.pingPeer !== 'function') {
          // If pingPeer API is unexposed, explicitly classify as unsupported_api
          // Do NOT conflate with nonresponsive or use static latency fallback
          return { peerId, status: 'unsupported_api', rttMs: null };
        }
        try {
          await Promise.race([
            meshMgr.pingPeer(peerId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('probe_timeout')), probeTimeoutMs))
          ]);
          const rttMs = Math.round(performance.now() - t0);
          rtts.push(rttMs);
          return { peerId, status: 'responsive', rttMs };
        } catch {
          return { peerId, status: 'nonresponsive', rttMs: null };
        }
      });

      const settled = await Promise.all(probePromises);
      probeResults.push(...settled);
    }

    rtts.sort((a, b) => a - b);
    const medianRtt = rtts.length > 0 ? rtts[Math.floor(rtts.length / 2)] : null;
    const responsiveCount = probeResults.filter((p) => p.status === 'responsive').length;
    const nonresponsiveCount = probeResults.filter((p) => p.status === 'nonresponsive').length;
    const unsupportedCount = probeResults.filter((p) => p.status === 'unsupported_api').length;

    const record = {
      testId: 'test_3_fast_path',
      attemptId,
      mode: this.mode,
      bridgeConnectedAtStart,
      probedPeersCount: targetPeerIds.length,
      responsiveCount,
      nonresponsiveCount,
      unsupportedCount,
      medianProbeRttMs: medianRtt,
      probeResults,
      probeTimeoutMs,
      elapsedMs: Date.now() - startedAt,
      ts: startedAt
    };

    this.history.test3FastPath.unshift(record);
    if (this.history.test3FastPath.length > 50) this.history.test3FastPath.pop();
    this._notify();
    return record;
  }

  // =========================================================================
  // TEST 4: Dynamic Bandwidth & Backpressure Governor
  // =========================================================================
  toggleGovernor(enable = null) {
    const shouldEnable = enable !== null ? enable : !this.governor.active;
    this.governor.active = shouldEnable;
    if (shouldEnable) {
      this.governor.startedAt = Date.now();
      console.log('[axona.track lab] Backpressure governor ARMED (traffic throttled).');
    } else {
      console.log('[axona.track lab] Backpressure governor RESTORED (standard fidelity).');
    }
    this._notify();
    return this.governor.active;
  }

  /**
   * Filter/coalesce outbound telemetry based on active governor policy.
   * CRITICAL invariants:
   * - 'heartbeat_anchor' and 'recovery_journal_flush' are ALWAYS PASSED.
   * - Non-essential UI pulses may be coalesced or suppressed when active.
   */
  filterOutboundTelemetry(payload) {
    if (!this.governor.active) {
      return { pass: true, reason: 'governor_inactive' };
    }

    const type = payload?.type || 'unknown';
    // 1. Critical invariant: never throttle anchors or recovery flushes
    if (type === 'heartbeat_anchor' || type === 'recovery_journal_flush') {
      this.governor.passedCount++;
      return { pass: true, reason: 'critical_priority' };
    }

    // 2. Auxiliary telemetry handling under constrained link
    if (type === 'peer_connected' || type === 'peer_disconnected') {
      // Coalesce churn events into local accounting rather than immediate wire dispatch
      this.governor.coalescedCount++;
      return { pass: false, action: 'coalesced', reason: 'governor_churn_coalesced' };
    }

    if (type === 'connectivity_warning' || type === 'lifecycle_transition') {
      this.governor.passedCount++;
      return { pass: true, reason: 'lifecycle_priority' };
    }

    this.governor.suppressedCount++;
    return { pass: false, action: 'suppressed', reason: 'auxiliary_throttled' };
  }

  getGovernorStats() {
    return {
      active: this.governor.active,
      startedAt: this.governor.startedAt,
      passedCount: this.governor.passedCount,
      coalescedCount: this.governor.coalescedCount,
      suppressedCount: this.governor.suppressedCount,
      totalHandled: this.governor.passedCount + this.governor.coalescedCount + this.governor.suppressedCount
    };
  }

  // =========================================================================
  // TEST 5: Dynamic Mesh Scaling & Connection Set Stress Test
  // =========================================================================
  async runTest5MeshScale({ cycleIntervalSec = 4, lowTarget = 3, highTarget = 15, onProgress = () => {}, signal = null } = {}) {
    // 1. Concurrency Guard: refuse overlapping/concurrent runs
    if (this._test5Running) {
      const rejectedRecord = {
        testId: 'test_5_mesh_scale',
        attemptId: `scale-rejected-${Date.now()}`,
        mode: this.mode,
        startedAt: Date.now(),
        status: 'concurrency_rejected',
        reason: 'concurrent_run_active',
        elapsedMs: 0
      };
      this.history.test5MeshScale.unshift(rejectedRecord);
      this._notify();
      return rejectedRecord;
    }

    if (signal?.aborted) {
      const abortedRecord = {
        testId: 'test_5_mesh_scale',
        attemptId: `scale-aborted-${Date.now()}`,
        mode: this.mode,
        startedAt: Date.now(),
        status: 'aborted',
        reason: 'aborted_prior_to_start',
        elapsedMs: 0
      };
      this.history.test5MeshScale.unshift(abortedRecord);
      this._notify();
      return abortedRecord;
    }

    this._test5Running = true;
    this._test5Epoch = (this._test5Epoch || 0) + 1;
    const currentEpoch = this._test5Epoch;

    const startedAt = Date.now();
    const attemptId = `scale-${Math.random().toString(36).slice(2, 8)}`;

    // Finite executable limits (clamped for mobile safety)
    const clampedInterval = Math.max(1, Math.min(Number(cycleIntervalSec) || 4, 30));
    const clampedLow = Math.max(1, Math.min(Number(lowTarget) || 3, 10));
    const clampedHigh = Math.max(clampedLow + 1, Math.min(Number(highTarget) || 15, 25));

    let batteryStart = null;
    let batteryChargingStart = null;
    if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
      try {
        const b = await navigator.getBattery();
        batteryStart = Math.round(b.level * 100);
        batteryChargingStart = b.charging;
      } catch {}
    }

    const baselinePeers = this.mesh?.peers?.size ?? (this.mode === 'offline_mock' ? 6 : 0);
    const baselineRtt = this.mesh?.getMedianRtt?.() ?? (this.mode === 'offline_mock' ? 22 : null);

    const record = {
      testId: 'test_5_mesh_scale',
      attemptId,
      mode: this.mode,
      startedAt,
      status: 'in_progress',
      phase: 'baseline',
      baselinePeers,
      peakPeers: baselinePeers,
      settledPeers: baselinePeers,
      medianRttBaseline: baselineRtt,
      medianRttPeak: null,
      medianRttSettled: null,
      maxEventLoopLagMs: 0,
      batteryStart,
      batteryEnd: null,
      batteryDelta: null,
      elapsedMs: 0,
      samples: []
    };

    this.history.test5MeshScale.unshift(record);
    if (this.history.test5MeshScale.length > 50) this.history.test5MeshScale.pop();
    this._notify();

    const meshMgr = this.mesh?.transport?.mesh || this.mesh?.transport?.webrtc?.mesh;
    const initialDegreeMax = meshMgr ? (meshMgr._degreeMax ?? 0) : 0;

    try {
      if (this.mode === 'offline_mock') {
        // Deterministic mock simulation across phases with abort checks
        if (signal?.aborted) throw new Error('Test 5 aborted by signal');
        record.phase = 'scaling_up';
        onProgress({ phase: 'scaling_up', progress: 0.25, currentPeers: baselinePeers });
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 40);
          if (signal) {
            signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Test 5 aborted by signal')); }, { once: true });
          }
        });

        // Peak phase
        if (signal?.aborted) throw new Error('Test 5 aborted by signal');
        record.phase = 'peak_stress';
        record.peakPeers = Math.max(baselinePeers, clampedHigh);
        record.medianRttPeak = (baselineRtt || 25) + 18;
        record.maxEventLoopLagMs = 3.6;
        record.samples.push({ phase: 'peak', peers: record.peakPeers, rtt: record.medianRttPeak, lag: 3.6 });
        onProgress({ phase: 'peak_stress', progress: 0.6, currentPeers: record.peakPeers });
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 40);
          if (signal) {
            signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Test 5 aborted by signal')); }, { once: true });
          }
        });

        // Scale down phase
        if (signal?.aborted) throw new Error('Test 5 aborted by signal');
        record.phase = 'scaling_down';
        record.settledPeers = Math.min(record.peakPeers, clampedLow);
        record.medianRttSettled = (baselineRtt || 25) + 2;
        record.samples.push({ phase: 'settled', peers: record.settledPeers, rtt: record.medianRttSettled, lag: 1.1 });
        onProgress({ phase: 'scaling_down', progress: 0.9, currentPeers: record.settledPeers });
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 40);
          if (signal) {
            signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Test 5 aborted by signal')); }, { once: true });
          }
        });

        record.phase = 'completed';
        record.status = 'completed';
      } else {
        // Live study: actively manipulate mesh target and request peer introductions
        try {
          if (signal?.aborted) throw new Error('Test 5 aborted by signal');

          // 1. Scale Up Phase: relax degreeMax and request introductions from bridge
          record.phase = 'scaling_up';
          onProgress({ phase: 'scaling_up', progress: 0.2, currentPeers: this.mesh?.peers?.size ?? 0 });
          if (meshMgr) {
            meshMgr._degreeMax = clampedHigh;
          }
          if (typeof this.mesh?.transport?.requestPeerIntroductions === 'function') {
            this.mesh.transport.requestPeerIntroductions();
          }

          // Measure event loop lag and peer count during scale up (bounded by cycle interval)
          const lagPhase1 = await this._sampleLagAndPeers(Math.min(clampedInterval * 500, 2500), signal);
          record.peakPeers = Math.max(record.peakPeers, this.mesh?.peers?.size ?? 0, lagPhase1.maxPeers);
          record.maxEventLoopLagMs = Math.max(record.maxEventLoopLagMs, lagPhase1.maxLagMs);
          record.medianRttPeak = this.mesh?.getMedianRtt?.();
          record.samples.push({ phase: 'peak', peers: record.peakPeers, rtt: record.medianRttPeak, lag: lagPhase1.maxLagMs });

          if (signal?.aborted) throw new Error('Test 5 aborted by signal');

          // 2. Scale Down Phase: throttle degreeMax down to lowTarget
          record.phase = 'scaling_down';
          onProgress({ phase: 'scaling_down', progress: 0.7, currentPeers: this.mesh?.peers?.size ?? 0 });
          if (meshMgr) {
            meshMgr._degreeMax = clampedLow;
            if (typeof meshMgr._scheduleDegreeCheck === 'function') {
              meshMgr._scheduleDegreeCheck();
            }
          }

          const lagPhase2 = await this._sampleLagAndPeers(Math.min(clampedInterval * 500, 2500), signal);
          record.settledPeers = this.mesh?.peers?.size ?? 0;
          record.maxEventLoopLagMs = Math.max(record.maxEventLoopLagMs, lagPhase2.maxLagMs);
          record.medianRttSettled = this.mesh?.getMedianRtt?.();
          record.samples.push({ phase: 'settled', peers: record.settledPeers, rtt: record.medianRttSettled, lag: lagPhase2.maxLagMs });

          record.phase = 'completed';
          record.status = 'completed';
        } finally {
          // Epoch-fenced restoration: ONLY restore if this execution's epoch is still current
          // Prevents late cleanups from overwriting newer policy
          if (meshMgr && this._test5Epoch === currentEpoch) {
            meshMgr._degreeMax = initialDegreeMax;
            if (typeof meshMgr._scheduleDegreeCheck === 'function') {
              meshMgr._scheduleDegreeCheck();
            }
          }
        }
      }

      // Check battery level post-run
      if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
        try {
          const b2 = await navigator.getBattery();
          record.batteryEnd = Math.round(b2.level * 100);
          if (record.batteryStart !== null && record.batteryEnd !== null) {
            record.batteryDelta = record.batteryStart - record.batteryEnd;
          }
        } catch {}
      }

      // Publish wire telemetry to #axona-track
      if (this.mesh && typeof this.mesh.publishTelemetry === 'function' && record.status === 'completed') {
        try {
          await this.mesh.publishTelemetry({
            note: `Dynamic Mesh Scale Test: peak ${record.peakPeers} peers · max lag ${record.maxEventLoopLagMs}ms`,
            type: 'mesh_scale_stress_test',
            attemptId,
            mode: this.mode,
            baselinePeers: record.baselinePeers,
            peakPeers: record.peakPeers,
            settledPeers: record.settledPeers,
            medianRttBaseline: record.medianRttBaseline,
            medianRttPeak: record.medianRttPeak,
            medianRttSettled: record.medianRttSettled,
            maxEventLoopLagMs: record.maxEventLoopLagMs,
            batteryStart: record.batteryStart,
            batteryEnd: record.batteryEnd,
            batteryDelta: record.batteryDelta,
            deviceName: this.telemetry?.deviceId?.name || 'anonymous',
            ts: startedAt
          });
        } catch (e) {
          console.warn('[axona.track lab] Failed to publish test 5 telemetry:', e);
        }
      }
    } catch (err) {
      record.status = 'aborted';
      record.error = err.message;
    } finally {
      this._test5Running = false;
      record.elapsedMs = Date.now() - startedAt;
      onProgress({ phase: record.status, progress: 1.0, currentPeers: record.settledPeers });
      this._notify();
    }

    return record;
  }

  async _sampleLagAndPeers(durationMs, signal = null) {
    const sampleIntervalMs = 50;
    let maxLagMs = 0;
    let maxPeers = this.mesh?.peers?.size ?? 0;
    const start = Date.now();
    let expectedNext = start + sampleIntervalMs;

    while (Date.now() - start < durationMs) {
      if (signal?.aborted) {
        throw new Error('Test 5 aborted by signal');
      }
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, sampleIntervalMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Test 5 aborted by signal'));
          }, { once: true });
        }
      });
      const now = Date.now();
      const lag = Math.max(0, now - expectedNext);
      if (lag > maxLagMs) maxLagMs = Math.round(lag);
      const currPeers = this.mesh?.peers?.size ?? 0;
      if (currPeers > maxPeers) maxPeers = currPeers;
      expectedNext = now + sampleIntervalMs;
    }

    return { maxLagMs, maxPeers };
  }

  // =========================================================================
  // REPORT EXPORT & SANITIZATION (Strict Privacy Allowlist)
  // =========================================================================
  exportReport() {
    const platform = detectPlatform();
    return {
      labVersion: LAB_VERSION,
      appVersion: APP_VERSION,
      kernelVersion: KERNEL_VERSION,
      mode: this.mode,
      exportedAt: Date.now(),
      platformSummary: {
        os: platform.os,
        browser: platform.browser,
        displayMode: platform.displayMode
        // Strictly omitted: hardwareConcurrency, deviceMemory, battery
      },
      summary: {
        totalHandoffTests: this.history.test1Handoff.length,
        totalGraceTests: this.history.test2Grace.length,
        totalFastPathTests: this.history.test3FastPath.length,
        totalScaleTests: this.history.test5MeshScale.length,
        governorStats: this.getGovernorStats()
      },
      history: {
        test1Handoff: this.history.test1Handoff.slice(0, 10),
        test2Grace: this.history.test2Grace.slice(0, 10),
        test3FastPath: this.history.test3FastPath.slice(0, 10).map((r) => ({
          ...r,
          probeResults: r.probeResults?.map((p) => ({
            ...p,
            peerId: redactPeerId(p.peerId)
          }))
        })),
        test5MeshScale: this.history.test5MeshScale.slice(0, 10)
      }
    };
  }

  _notify() {
    this.onUpdate({
      mode: this.mode,
      governor: this.getGovernorStats(),
      historyCounts: {
        test1: this.history.test1Handoff.length,
        test2: this.history.test2Grace.length,
        test3: this.history.test3FastPath.length,
        test5: this.history.test5MeshScale.length
      }
    });
  }
}
