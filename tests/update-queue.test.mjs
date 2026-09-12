import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateQueue } from '../src/shared/update-queue.js';
import { createDeferred, createWorkBudget, yieldToUi } from '../src/shared/utils.js';

test('coalesces latest book payloads without losing other books or structural updates', async () => {
  const batches = [];
  const queue = createUpdateQueue({ delayMs: 1, processBatch: async (items) => {
    batches.push(items.map(({ name, data }) => ({ name, data })));
  } });
  await Promise.all([
    queue.enqueue('A', { version: 1 }),
    queue.enqueue('B', { version: 1 }),
    queue.enqueue(null),
    queue.enqueue('A', { version: 2 }),
  ]);
  assert.deepEqual(batches, [[
    { name: 'A', data: { version: 2 } },
    { name: 'B', data: { version: 1 } },
    { name: null, data: null },
  ]]);
  queue.dispose();
});

test('direct reconciliation flushes pending events and resolves only after reconciliation', async () => {
  const gate = createDeferred();
  let completed = false;
  let calls = 0;
  const queue = createUpdateQueue({ delayMs: 60_000, processBatch: async () => {
    calls += 1;
    await gate.promise;
  } });
  const event = queue.enqueue('A', { version: 1 });
  const direct = queue.enqueue('A', { version: 2 }, { immediate: true }).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(completed, false);
  gate.resolve();
  await Promise.all([event, direct]);
  assert.equal(completed, true);
  queue.dispose();
});

test('serializes events arriving during work into a following batch', async () => {
  const gate = createDeferred();
  const batches = [];
  let active = 0;
  let maxActive = 0;
  const queue = createUpdateQueue({ processBatch: async (items) => {
    maxActive = Math.max(maxActive, ++active);
    batches.push(items.map(({ data }) => data.version));
    if (batches.length === 1) await gate.promise;
    active -= 1;
  } });
  const first = queue.enqueue('A', { version: 1 }, { immediate: true });
  await Promise.resolve();
  const second = queue.enqueue('A', { version: 2 });
  const third = queue.enqueue('B', { version: 3 }, { immediate: true });
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(maxActive, 1);
  assert.deepEqual(batches, [[1], [2, 3]]);
  queue.dispose();
});

test('reports per-book failures without failing successfully reconciled books', async () => {
  const failure = new Error('book A failed');
  const queue = createUpdateQueue({ processBatch: async () => new Map([['A', failure]]) });
  const results = await Promise.allSettled([
    queue.enqueue('A', {}, { immediate: true }),
    queue.enqueue('B', {}, { immediate: true }),
  ]);
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].status, 'fulfilled');
  queue.dispose();
});

test('batch failure settles all callers and a later batch can retry', async () => {
  let calls = 0;
  const queue = createUpdateQueue({ processBatch: async () => {
    if (++calls === 1) throw new Error('read failed');
  } });
  await assert.rejects(queue.enqueue('A', {}, { immediate: true }), /read failed/);
  await queue.enqueue('A', {}, { immediate: true });
  assert.equal(calls, 2);
  queue.dispose();
});

test('cleanup cancels pending work and invalidates an active batch', async () => {
  const gate = createDeferred();
  let current;
  const queue = createUpdateQueue({ processBatch: async (_, isCurrent) => {
    await gate.promise;
    current = isCurrent();
  } });
  const first = queue.enqueue('A', {}, { immediate: true });
  await Promise.resolve();
  const second = queue.enqueue('B', {});
  const results = Promise.allSettled([first, second]);
  queue.dispose();
  assert.equal((await results).every(({ reason }) => reason?.name === 'AbortError'), true);
  gate.resolve();
  await Promise.resolve();
  assert.equal(current, false);
});

test('work budget yields for elapsed work or item count, and excludes waiting time', async () => {
  let time = 0;
  let yields = 0;
  const checkpoint = createWorkBudget({ maxItems: 3, budgetMs: 8, now: () => time,
    yieldTask: async () => { yields += 1; time += 100; } });
  assert.equal(checkpoint(), null);
  time = 8;
  await checkpoint();
  assert.equal(yields, 1);
  assert.equal(checkpoint(), null);
  assert.equal(checkpoint(), null);
  await checkpoint();
  assert.equal(yields, 2);
});

test('UI yielding uses the browser scheduler when available and a task fallback otherwise', async () => {
  const original = globalThis.scheduler;
  let calls = 0;
  try {
    globalThis.scheduler = { yield: async () => { calls += 1; } };
    await yieldToUi();
    assert.equal(calls, 1);
    globalThis.scheduler = undefined;
    let microtaskFinished = false;
    queueMicrotask(() => { microtaskFinished = true; });
    await yieldToUi();
    assert.equal(microtaskFinished, true);
  } finally {
    if (original === undefined) delete globalThis.scheduler;
    else globalThis.scheduler = original;
  }
});
