import { describe, expect, test } from 'bun:test';
import { SqliteSessionStore } from '../../src/adapter/sqlite/session-store.ts';

describe('session maintenance cancellation provenance', () => {
  test.each([
    ['Error', new Error('operator cancelled')], ['string', 'shutdown'], ['object', { code: 'STOP_MAINTENANCE' }],
  ] as const)(
    'preserves a %s reason when cancellation interrupts the native batch yield', async (_kind, reason) => {
      let now = 0;
      const sessions = new SqliteSessionStore(':memory:', { ttlSeconds: 1, now: () => now });
      const controller = new AbortController();
      try {
        for (let i = 0; i < 3; i++) sessions.create({ tenantId: 'tenant', subjectId: 'subject', sessionId: '' });
        now = 1000;
        const pending = sessions.pruneExpiredAsync({ batchSize: 1, signal: controller.signal });
        queueMicrotask(() => controller.abort(reason));
        await expect(pending).rejects.toBe(reason);
        // The first batch committed, but cancellation admitted no second batch.
        expect(sessions.pruneExpired()).toBe(2);
      } finally { sessions.close(); }
    },
  );
});
