import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadBoundaryContract } from '../src/contract/load.ts';
import { SqliteOrderStore } from '../src/adapter/sqlite/order-store.ts';
import { createOrderBindings } from '../src/runtime/order-bindings.ts';
import { OrderCoordinator } from '../src/runtime/order-coordinator.ts';
import { createOrderApp } from '../src/adapter/hono/order-app.ts';
import { SqliteCredentialStore, SqliteSessionStore } from '../src/adapter/sqlite/session-store.ts';
import type { Principal } from '../src/runtime/order.ts';

const contractPath = resolve(import.meta.dir, '../docs/design/v0.5/examples/order.boundary.json');
const databasePath = process.env.DATABASE_PATH ?? resolve(import.meta.dir, '../.data/orders.sqlite');
const port = Number(process.env.PORT ?? 3000);
const origin = process.env.ALLOWED_ORIGIN ?? `http://localhost:${port}`;

if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

const principal: Principal = {
  subjectId: 'subject_demo',
  tenantId: 'tenant_demo',
  sessionId: 'session_demo',
};
const store = new SqliteOrderStore(databasePath);
store.seedMembership(principal.tenantId, principal.subjectId, true);
store.seedProduct({
  id: 'p_100',
  tenantId: principal.tenantId,
  name: 'Demo product',
  revision: 7,
  active: true,
  priceMinor: 12000,
  currency: 'KRW',
});
const loaded = await loadBoundaryContract(contractPath);
const coordinator = new OrderCoordinator({
  loaded,
  bindings: createOrderBindings(),
  storage: store,
});
const sessions = new SqliteSessionStore(databasePath);
const credentials = new SqliteCredentialStore(databasePath);
await credentials.seed(
  principal.tenantId,
  principal.subjectId,
  process.env.DEMO_PASSWORD ?? 'demo-password',
);
if (process.env.DEMO_PASSWORD === undefined) {
  console.warn('Using the default demo password. Set DEMO_PASSWORD for anything beyond local use.');
}
const app = createOrderApp({
  loaded,
  coordinator,
  sessions,
  credentials,
  allowedOrigins: [origin],
  demo: { principal, productId: 'p_100' },
});

const server = Bun.serve({ port, fetch: app.fetch });
console.log(`TypeHTML order demo listening on ${origin}`);
console.log(`Open ${origin}/login and sign in as ${principal.tenantId} / ${principal.subjectId}.`);
console.log(`Database: ${databasePath}`);

function shutdown(): void {
  server.stop(true);
  store.close();
  sessions.close();
  credentials.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
