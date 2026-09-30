// test/adaptation_lab.test.mjs — Deterministic unit tests for Adaptation Lab (v0.2.1)

import assert from 'node:assert/strict';
import { AdaptationLab } from '../src/lab.js';

console.log('\n--- RUNNING ADAPTATION LAB UNIT TESTS ---');

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    console.error(`✗ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 1. Initialization and mode toggle
await test('Initializes in offline_mock mode and validates mode switching', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });
  assert.equal(lab.mode, 'offline_mock');

  lab.setMode('live_study');
  assert.equal(lab.mode, 'live_study');

  assert.throws(() => lab.setMode('invalid_mode'), /Invalid lab mode/);
  lab.setMode('offline_mock');
});

// 2. Test 1: Pre-Freeze Role Relinquish Handoff
await test('Test 1: Handoff simulation resolves with accurate outcome and denominator preservation', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  const res1 = await lab.runTest1Handoff({ timeoutMs: 1000 });
  assert.equal(res1.testId, 'test_1_handoff');
  assert.equal(res1.outcome, 'settled_resolved');
  assert.ok(res1.elapsedMs >= 0);
  assert.ok(res1.attemptId.startsWith('handoff-'));

  assert.equal(lab.history.test1Handoff.length, 1);
});

// 3. Test 2: Tiered Mobile Grace Period & Eviction Profiler
await test('Test 2: Tier classification and retention state accounting', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  // Under 10s
  const res1 = lab.runTest2GracePeriod({ simulatedIntervalMs: 4500, prePeersCount: 5, survivingPeersCount: 5 });
  assert.equal(res1.tier, 'tier_under_10s');
  assert.equal(res1.retentionRatio, 1.0);
  assert.equal(res1.retentionState, 'cached_peer_ids_retained');

  // 10s - 60s
  const res2 = lab.runTest2GracePeriod({ simulatedIntervalMs: 25000, prePeersCount: 4, survivingPeersCount: 3 });
  assert.equal(res2.tier, 'tier_10s_to_60s');
  assert.equal(res2.retentionRatio, 0.75);

  // Over 5m with zero retained
  const res3 = lab.runTest2GracePeriod({ simulatedIntervalMs: 400000, prePeersCount: 4, survivingPeersCount: 0 });
  assert.equal(res3.tier, 'tier_over_5m');
  assert.equal(res3.retentionRatio, 0.0);
  assert.equal(res3.retentionState, 'no_cached_peer_ids_retained');

  // Baseline unavailable in live study when no pre-freeze snapshot exists
  const liveLab = new AdaptationLab({ mode: 'live_study' });
  const res4 = liveLab.runTest2GracePeriod({ simulatedIntervalMs: 5000 });
  assert.equal(res4.retentionState, 'baseline_unavailable');
  assert.equal(res4.prePeersCount, null);
  assert.equal(res4.retentionRatio, null);
});

// 4. Test 3: Fast-Path Reconnection & Active Channel Probing
await test('Test 3: Active probing respects finite bounds, clamping (<=3), and median calculation', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  // Probe with clamp check (maxProbes: 10 clamped to 3)
  const res = await lab.runTest3FastPath({ probeTimeoutMs: 1000, maxProbes: 10 });
  assert.equal(res.testId, 'test_3_fast_path');
  assert.ok(res.probedPeersCount <= 3);
  assert.ok(res.responsiveCount <= 3);
  assert.ok(res.medianProbeRttMs !== null);

  // Live study with unexposed pingPeer reports unsupported_api rather than nonresponsive
  const mockMesh = {
    isConnected: true,
    peers: new Map([['peer-1234567890abcdef', {}]]),
    transport: { mesh: { pingPeer: undefined } }
  };
  const liveLab = new AdaptationLab({ mode: 'live_study', mesh: mockMesh });
  const liveRes = await liveLab.runTest3FastPath({ maxProbes: 1 });
  assert.equal(liveRes.probedPeersCount, 1);
  assert.equal(liveRes.unsupportedCount, 1);
  assert.equal(liveRes.nonresponsiveCount, 0);
  assert.equal(liveRes.probeResults[0].status, 'unsupported_api');
});

// 5. Test 4: Dynamic Bandwidth & Backpressure Governor
await test('Test 4: Governor priority invariants (anchors and flushes NEVER dropped)', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });
  assert.equal(lab.governor.active, false);

  // Arm governor
  lab.toggleGovernor(true);
  assert.equal(lab.governor.active, true);

  // Critical events MUST pass
  const passAnchor = lab.filterOutboundTelemetry({ type: 'heartbeat_anchor' });
  assert.equal(passAnchor.pass, true);
  assert.equal(passAnchor.reason, 'critical_priority');

  const passRecovery = lab.filterOutboundTelemetry({ type: 'recovery_journal_flush' });
  assert.equal(passRecovery.pass, true);
  assert.equal(passRecovery.reason, 'critical_priority');

  // Churn events must be coalesced
  const coalesceChurn = lab.filterOutboundTelemetry({ type: 'peer_connected' });
  assert.equal(coalesceChurn.pass, false);
  assert.equal(coalesceChurn.action, 'coalesced');

  // Auxiliary events must be suppressed
  const suppressAux = lab.filterOutboundTelemetry({ type: 'ui_pulse' });
  assert.equal(suppressAux.pass, false);
  assert.equal(suppressAux.action, 'suppressed');

  const stats = lab.getGovernorStats();
  assert.equal(stats.passedCount, 2);
  assert.equal(stats.coalescedCount, 1);
  assert.equal(stats.suppressedCount, 1);
  assert.equal(stats.totalHandled, 4);

  // Restore governor
  lab.toggleGovernor(false);
  assert.equal(lab.governor.active, false);
  const inactivePass = lab.filterOutboundTelemetry({ type: 'ui_pulse' });
  assert.equal(inactivePass.pass, true);
});

// 6. Privacy Export Allowlist & Redaction
await test('Report export strictly omits hardware concurrency, RAM, and battery, and redacts peer IDs', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });
  await lab.runTest3FastPath({ maxProbes: 2 });
  const report = lab.exportReport();

  assert.ok(report.labVersion);
  assert.ok(report.platformSummary.os);
  assert.ok(report.platformSummary.browser);

  // Strict privacy assertion: ensure hardware concurrency, RAM, and battery are NOT exposed
  assert.equal(report.platformSummary.hardwareConcurrency, undefined);
  assert.equal(report.platformSummary.deviceMemory, undefined);
  assert.equal(report.platformSummary.battery, undefined);

  // Redaction check: peer IDs in test3 results must be redacted
  const fastPathHistory = report.history.test3FastPath;
  assert.ok(fastPathHistory.length > 0);
  for (const record of fastPathHistory) {
    for (const p of record.probeResults) {
      assert.ok(p.peerId.length <= 9, `peerId '${p.peerId}' should be redacted to <= 9 chars`);
    }
  }
});

// 7. Test 5: Dynamic Mesh Scaling & Connection Set Stress Test
await test('Test 5: Dynamic mesh scaling cycles targets, samples event-loop lag, and records history', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  let progressPhases = [];
  const res = await lab.runTest5MeshScale({
    cycleIntervalSec: 1,
    lowTarget: 3,
    highTarget: 15,
    onProgress: (p) => progressPhases.push(p.phase)
  });

  assert.equal(res.testId, 'test_5_mesh_scale');
  assert.equal(res.status, 'completed');
  assert.ok(res.peakPeers >= 15);
  assert.ok(res.settledPeers <= 3);
  assert.ok(res.maxEventLoopLagMs >= 0);
  assert.ok(res.samples.length >= 2);
  assert.ok(progressPhases.includes('scaling_up'));
  assert.ok(progressPhases.includes('peak_stress'));
  assert.ok(progressPhases.includes('scaling_down'));

  // Ensure record is in history
  assert.equal(lab.history.test5MeshScale.length, 1);
  assert.equal(lab.history.test5MeshScale[0].attemptId, res.attemptId);

  // Check exported report includes test5 summary
  const report = lab.exportReport();
  assert.equal(report.summary.totalScaleTests, 1);
  assert.equal(report.history.test5MeshScale.length, 1);
});

// 8. Test 5 Concurrency Lock Guard
await test('Test 5: Rejects concurrent run invocations while a run is active', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  // Start a run that takes some time
  const p1 = lab.runTest5MeshScale({ cycleIntervalSec: 2, lowTarget: 3, highTarget: 10 });

  // Concurrently attempt a second run
  const res2 = await lab.runTest5MeshScale({ cycleIntervalSec: 2, lowTarget: 3, highTarget: 10 });
  assert.equal(res2.status, 'concurrency_rejected');
  assert.equal(res2.reason, 'concurrent_run_active');

  // Await the first run to complete
  const res1 = await p1;
  assert.equal(res1.status, 'completed');

  // Verify that after p1 finishes, a subsequent run succeeds
  const res3 = await lab.runTest5MeshScale({ cycleIntervalSec: 1, lowTarget: 3, highTarget: 8 });
  assert.equal(res3.status, 'completed');
});

// 9. Test 5 AbortSignal Cancellation
await test('Test 5: AbortSignal halts in-flight testing and cleans up status', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  const controller = new AbortController();
  // Trigger abort shortly after start
  setTimeout(() => controller.abort(), 20);

  const res = await lab.runTest5MeshScale({
    cycleIntervalSec: 5,
    lowTarget: 3,
    highTarget: 12,
    signal: controller.signal
  });

  assert.equal(res.status, 'aborted');
  assert.ok(res.error.includes('aborted by signal'));

  // Ensure mutex was cleanly released so a subsequent run can execute
  const resFollowup = await lab.runTest5MeshScale({ cycleIntervalSec: 1, lowTarget: 2, highTarget: 6 });
  assert.equal(resFollowup.status, 'completed');
});

// 10. Test 5 Epoch Fencing Guard
await test('Test 5: Epoch fencing prevents a late cleanup from overwriting newer degree policy', async () => {
  const mockMeshMgr = { _degreeMax: 8, _scheduleDegreeCheck: () => {} };
  const mockMesh = {
    isConnected: true,
    peers: new Map(),
    transport: { mesh: mockMeshMgr },
    getMedianRtt: () => 30
  };
  const lab = new AdaptationLab({ mode: 'live_study', mesh: mockMesh });

  // Simulate starting Test 5 run 1
  const controller = new AbortController();
  const p1 = lab.runTest5MeshScale({ cycleIntervalSec: 1, lowTarget: 2, highTarget: 15, signal: controller.signal });

  // In the meantime, simulate external epoch advancement
  lab._test5Epoch = 999;
  mockMeshMgr._degreeMax = 20; // newer policy applied

  controller.abort();
  await p1;

  // Verify that degreeMax was NOT overwritten back to 8 by the aborted run's cleanup
  assert.equal(mockMeshMgr._degreeMax, 20);
});

console.log('\n========================================');
console.log('RESULT: All Adaptation Lab tests passed.');
console.log('========================================\n');

