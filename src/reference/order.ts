/** Bun-only order example. This is intentionally separate from the generic form API. */
import { fileURLToPath } from 'node:url';
import { loadBoundaryContract } from '../contract/load.ts';

export * from '../runtime/order.ts';
export * from '../runtime/order-bindings.ts';
export * from '../runtime/order-storage.ts';
export * from '../runtime/order-coordinator.ts';
export * from '../runtime/session.ts';
export * from '../adapter/sqlite/order-store.ts';
export * from '../adapter/sqlite/session-store.ts';
export { createOrderApp, type OrderAppOptions } from '../adapter/hono/order-app.ts';
export * from '../adapter/hono/rate-limit.ts';
export * from '../render/order-html.ts';

export function loadReferenceOrderContract() {
  return loadBoundaryContract(fileURLToPath(new URL('./order.boundary.json', import.meta.url)));
}
