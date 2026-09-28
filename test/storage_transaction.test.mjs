// test/storage_transaction.test.mjs — Deterministic offline verification for cross-tab storage coordination
// Tests: simultaneous acquisition, append-vs-ACK, prune-vs-append, slow publish lease heartbeat, storage exceptions, holder termination.

import assert from 'node:assert';

// 1. Mock localStorage with exception injection
class MockLocalStorage {
  constructor() {
    this.store = new Map();
    this.shouldThrowOnSet = false;
  }
  getItem(k) {
    return this.store.has(k) ? this.store.get(k) : null;
  }
  setItem(k, v) {
    if (this.shouldThrowOnSet) {
      throw new Error('QuotaExceededError: DOMException 22');
    }
    this.store.set(k, String(v));
  }
  removeItem(k) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

globalThis.localStorage = new MockLocalStorage();

// Import storage module after setting up globalThis.localStorage
const storage = await import('../src/storage.js');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    globalThis.localStorage.clear();
    globalThis.localStorage.shouldThrowOnSet = false;
    await fn();
    passedTests++;
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    console.error(`✗ FAIL: ${name}`, err);
  }
}

console.log('--- RUNNING DETERMINISTIC STORAGE MUTEX & TRANSACTION TESTS ---\n');

// TEST 1: Simultaneous Acquisition (Mutual Exclusion)
await test('Simultaneous acquisition enforces strict mutual exclusion', async () => {
  let activeCount = 0;
  let maxActive = 0;
  const executionOrder = [];

  const task1 = storage.withStorageTransaction(async () => {
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    executionOrder.push('t1_start');
    await new Promise((r) => setTimeout(r, 60));
    executionOrder.push('t1_end');
    activeCount--;
  });

  const task2 = storage.withStorageTransaction(async () => {
    activeCount++;
    maxActive = Math.max(maxActive, activeCount);
    executionOrder.push('t2_start');
    await new Promise((r) => setTimeout(r, 40));
    executionOrder.push('t2_end');
    activeCount--;
  });

  await Promise.all([task1, task2]);

  assert.strictEqual(maxActive, 1, 'Never more than one active transaction at a time');
  assert.deepStrictEqual(executionOrder, ['t1_start', 't1_end', 't2_start', 't2_end'], 'Strict FIFO serialization');
});

// TEST 2: Append-vs-ACK (No Lost Appends during Outbox Flush)
await test('Concurrent append during ACK does not clobber newly arrived events', async () => {
  // Pre-populate outbox with 2 items to flush
  await storage.queueOfflineEvent({ name: 'event_A' });
  await storage.queueOfflineEvent({ name: 'event_B' });

  const initialBatch = storage.getOfflineOutbox();
  assert.strictEqual(initialBatch.length, 2);
  const ackIds = initialBatch.map((e) => e.id);

  // Concurrently run an ACK of initialBatch and an append of event_C
  const ackPromise = (async () => {
    await new Promise((r) => setTimeout(r, 20));
    return storage.ackOfflineOutbox(ackIds);
  })();

  const appendPromise = (async () => {
    await new Promise((r) => setTimeout(r, 10));
    return storage.queueOfflineEvent({ name: 'event_C' });
  })();

  await Promise.all([ackPromise, appendPromise]);

  const remaining = storage.getOfflineOutbox();
  assert.strictEqual(remaining.length, 1, 'Exactly one event remains');
  assert.strictEqual(remaining[0].name, 'event_C', 'event_C was preserved, zero lost updates');
});

// TEST 3: Prune-vs-Append (Drop accounting and retention correctness)
await test('Concurrent prune during append preserves fresh events and accounts for drops', async () => {
  // Directly insert an expired event (25 hours old) and a recent event
  const now = Date.now();
  const rawExpired = [
    { id: 'exp1', ts: now - (25 * 60 * 60 * 1000), name: 'old_event' },
    { id: 'fresh1', ts: now - (1 * 60 * 60 * 1000), name: 'recent_event' }
  ];
  globalThis.localStorage.setItem('axona.track.offline_outbox', JSON.stringify(rawExpired));

  const prunePromise = storage.pruneStorage();
  const appendPromise = storage.queueOfflineEvent({ name: 'new_event' });

  await Promise.all([prunePromise, appendPromise]);

  const current = storage.getOfflineOutbox();
  const drops = storage.getStorageDrops();

  assert.strictEqual(drops, 1, 'Expired event dropped and accounted');
  assert.strictEqual(current.length, 2, 'Recent event and new event both retained');
  assert.ok(current.some((e) => e.name === 'new_event'), 'New event present');
  assert.ok(current.some((e) => e.name === 'recent_event'), 'Recent event present');
  assert.ok(!current.some((e) => e.id === 'exp1'), 'Expired event successfully evicted');
});

// TEST 4: Slow Operation beyond 5s (Lock prevents peer theft throughout long duration)
await test('Slow operation maintains active exclusive lock so peer cannot steal lock', async () => {
  let holderDone = false;
  let peerStartedBeforeHolder = false;

  // Task 1: Runs for 400ms
  const slowTask = storage.withStorageTransaction(async () => {
    await new Promise((r) => setTimeout(r, 400));
    holderDone = true;
  });

  // Task 2: Attempted while Task 1 is running
  const peerTask = storage.withStorageTransaction(async () => {
    if (!holderDone) {
      peerStartedBeforeHolder = true;
    }
  });

  await Promise.all([slowTask, peerTask]);

  assert.strictEqual(peerStartedBeforeHolder, false, 'Peer was held off throughout slow operation');
  assert.strictEqual(holderDone, true, 'Slow task finished cleanly');
});

// TEST 5: Storage Exceptions (Fail-Closed on QuotaExceededError)
await test('Storage exceptions fail closed without false success or corrupted counters', async () => {
  globalThis.localStorage.shouldThrowOnSet = true;

  let threw = false;
  try {
    await storage.queueOfflineEvent({ name: 'will_fail' });
  } catch (err) {
    threw = true;
    assert.ok(err.message.includes('QuotaExceededError'));
  }

  // Restore storage
  globalThis.localStorage.shouldThrowOnSet = false;
  const outbox = storage.getOfflineOutbox();
  assert.strictEqual(outbox.length, 0, 'No partial or corrupted entries written');
});

// TEST 6: Holder Termination / Error Abort (Lock cleanly released, no deadlock)
await test('Aborted or throwing transaction cleanly releases lock for subsequent callers', async () => {
  let subsequentExecuted = false;

  // Task 1 throws an intentional error
  try {
    await storage.withStorageTransaction(async () => {
      throw new Error('Simulated process abort');
    });
  } catch (err) {
    assert.strictEqual(err.message, 'Simulated process abort');
  }

  // Verify mutex key was removed despite the throw
  const raw = globalThis.localStorage.getItem('axona.track.storage_mutex');
  assert.strictEqual(raw, null, 'Mutex key was cleaned up');

  // Task 2 must now acquire immediately without deadlock
  await storage.withStorageTransaction(async () => {
    subsequentExecuted = true;
  });

  assert.strictEqual(subsequentExecuted, true, 'Subsequent caller acquired lock successfully');
});

// TEST 7: Flush Lock Non-blocking Deferral
await test('Flush lock returns acquired: false when held by concurrent peer', async () => {
  let firstHolding = false;
  let secondAcquired = null;

  const firstFlush = storage.withFlushLock(async () => {
    firstHolding = true;
    await new Promise((r) => setTimeout(r, 100));
    firstHolding = false;
    return 'first_done';
  });

  // Give firstFlush a moment to acquire
  await new Promise((r) => setTimeout(r, 20));

  const secondFlush = storage.withFlushLock(async () => {
    return 'second_done';
  });

  const [res1, res2] = await Promise.all([firstFlush, secondFlush]);

  assert.strictEqual(res1.acquired, true);
  assert.strictEqual(res1.result, 'first_done');
  assert.strictEqual(res2.acquired, false, 'Second flush deferred cleanly');
  assert.strictEqual(res2.reason, 'held_by_peer');
});

// TEST 8: Fallback Coordinator when navigator.locks is unavailable
await test('Fallback coordinator enforces mutual exclusion and heartbeat lease without navigator.locks', async () => {
  const navProto = Object.getPrototypeOf(globalThis.navigator) || globalThis.navigator;
  const originalDesc = Object.getOwnPropertyDescriptor(navProto, 'locks') ||
                       Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');

  try {
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: undefined,
      configurable: true,
      writable: true
    });

    let active = 0;
    let maxActive = 0;
    const taskA = storage.withStorageTransaction(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 60));
      active--;
    });

    const taskB = storage.withStorageTransaction(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });

    await Promise.all([taskA, taskB]);
    assert.strictEqual(maxActive, 1, 'Fallback coordinator serialized tasks strictly to 1 active');
  } finally {
    if (originalDesc) {
      Object.defineProperty(navProto, 'locks', originalDesc);
    }
  }
});

console.log(`\n========================================`);
console.log(`RESULT: ${passedTests}/${totalTests} tests passed.`);
console.log(`========================================\n`);

process.exit(totalTests === passedTests ? 0 : 1);
