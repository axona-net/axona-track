// test/adaptation_lab.test.mjs — Deterministic unit tests for Adaptation Lab (v0.2.0)

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

  // Micro-pause (< 10s)
  const res1 = lab.runTest2GracePeriod({ simulatedIntervalMs: 4500, prePeersCount: 5, survivingPeersCount: 5 });
  assert.equal(res1.tier, 'tier_1_micropause');
  assert.equal(res1.retentionRatio, 1.0);
  assert.equal(res1.retentionState, 'cached_peer_ids_retained');

  // Screen lock (10s - 60s)
  const res2 = lab.runTest2GracePeriod({ simulatedIntervalMs: 25000, prePeersCount: 4, survivingPeersCount: 3 });
  assert.equal(res2.tier, 'tier_2_screen_lock');
  assert.equal(res2.retentionRatio, 0.75);

  // Deep freeze (> 5m) with zero retained
  const res3 = lab.runTest2GracePeriod({ simulatedIntervalMs: 400000, prePeersCount: 4, survivingPeersCount: 0 });
  assert.equal(res3.tier, 'tier_4_deep_freeze');
  assert.equal(res3.retentionRatio, 0.0);
  assert.equal(res3.retentionState, 'no_cached_peer_ids_retained');
});

// 4. Test 3: Fast-Path Reconnection & Active Channel Probing
await test('Test 3: Active probing respects finite bounds and median calculation', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });

  const res = await lab.runTest3FastPath({ probeTimeoutMs: 1000, maxProbes: 2 });
  assert.equal(res.testId, 'test_3_fast_path');
  assert.equal(res.probedPeersCount, 2);
  assert.equal(res.responsiveCount, 2);
  assert.ok(res.medianProbeRttMs !== null);
  assert.equal(res.probeResults.length, 2);
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

// 6. Privacy Export Allowlist
await test('Report export strictly omits hardware concurrency, RAM, and battery', async () => {
  const lab = new AdaptationLab({ mode: 'offline_mock' });
  const report = lab.exportReport();

  assert.ok(report.labVersion);
  assert.ok(report.platformSummary.os);
  assert.ok(report.platformSummary.browser);

  // Strict privacy assertion: ensure hardware concurrency, RAM, and battery are NOT exposed
  assert.equal(report.platformSummary.hardwareConcurrency, undefined);
  assert.equal(report.platformSummary.deviceMemory, undefined);
  assert.equal(report.platformSummary.battery, undefined);
});

console.log('\n========================================');
console.log('RESULT: All Adaptation Lab tests passed.');
console.log('========================================\n');
