import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadBoundaryContract } from '../src/contract/load.ts';
import { SqliteOrderStore } from '../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../src/runtime/order-coordinator.ts';
import type { Principal } from '../src/runtime/order.ts';

const iterations = Number(process.argv.find((value) => value.startsWith('--iterations='))?.split('=')[1] ?? 200);
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10_000) {
  throw new Error('iterations must be an integer between 1 and 10000');
}

const databasePath = resolve(
  import.meta.dir,
  '../.data/bench-' + crypto.randomUUID() + '.sqlite',
);
mkdirSync(dirname(databasePath), { recursive: true });
const now = () => 1_000_000;
const store = new SqliteOrderStore(databasePath, { now });
const principal: Principal = { tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: 'bench' };
store.seedMembership(principal.tenantId, principal.subjectId, true);
store.seedProduct({
  id: 'p_100',
  tenantId: principal.tenantId,
  name: 'Bench product',
  revision: 7,
  active: true,
  priceMinor: 12000,
  currency: 'KRW',
});
const loaded = await loadBoundaryContract(
  resolve(import.meta.dir, '../docs/design/v0.5/examples/order.boundary.json'),
);
const coordinator = new OrderCoordinator({
  loaded,
  bindings: createOrderBindings(),
  storage: store,
  now,
});

async function flow(): Promise<void> {
  const begin = await coordinator.beginDraft(principal, 'p_100');
  const result = await coordinator.submitIntent(principal, begin.intentId, {
    productId: 'p_100',
    quantity: '2',
  });
  if (!result.location.includes('/orders/drafts/')) throw new Error('unexpected location');
}

try {
  for (let index = 0; index < 10; index++) await flow();
  const samples: number[] = [];
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    const at = performance.now();
    await flow();
    samples.push(performance.now() - at);
  }
  const elapsed = performance.now() - started;
  samples.sort((left, right) => left - right);
  const percentile = (ratio: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * ratio))]!;
  console.log(JSON.stringify({
    iterations,
    database: 'sqlite-wal-synchronous-full',
    elapsedMs: Number(elapsed.toFixed(1)),
    meanMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(3)),
    p50Ms: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
    maxMs: Number(samples[samples.length - 1]!.toFixed(3)),
    throughputPerSecond: Number((iterations / (elapsed / 1000)).toFixed(1)),
    note: 'Single local Bun process, file-backed SQLite, no HTTP or session overhead. Not a capacity claim.',
  }, null, 2));
} finally {
  store.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(databasePath + suffix, { force: true });
}
