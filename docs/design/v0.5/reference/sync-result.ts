/** Compile-time restriction plus a required runtime check at synchronous role boundaries. */
export type SyncResult<T> = T extends null | undefined ? T : T & { readonly then?: never };
export function assertSynchronous<T>(value: T): SyncResult<T> {
  // Do not read a getter named then. Proxies may still trap `in` and must be trusted.
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
    throw new Error('ASYNC_ROLE_RESULT');
  return value as SyncResult<T>;
}
