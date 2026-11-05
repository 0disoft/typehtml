/** Compile-time restriction plus a required runtime check at synchronous role boundaries. */
export type SyncResult<T> = T extends null | undefined ? T : T & { readonly then?: never };

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in (value as Record<string, unknown>)
  );
}

/**
 * Rejects a Promise returned from a role the adapter expects to run inside a
 * synchronous SQLite transaction. The value is not awaited; nothing may escape
 * the transaction boundary before the rollback decision.
 */
export function assertSynchronous<T>(value: T): SyncResult<T> {
  if (isThenable(value)) {
    if (value instanceof Promise) void value.catch(() => undefined);
    throw new Error('ASYNC_ROLE_RESULT');
  }
  return value as SyncResult<T>;
}
