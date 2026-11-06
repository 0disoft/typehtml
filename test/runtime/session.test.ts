import { describe, expect, it } from 'bun:test';
import { InMemorySessionStore } from '../../src/runtime/session.ts';

describe('in-memory session ownership', () => {
  it.each(['create', 'get'] as const)('prevents %s results from changing stored identity or CSRF state', (source) => {
    const sessions = new InMemorySessionStore();
    const created = sessions.create({ tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: '' });
    const expected = structuredClone(created);
    const exposed = source === 'create' ? created : sessions.get(created.id)!;

    expect(Reflect.set(exposed, 'id', 'different-session')).toBe(false);
    expect(Reflect.set(exposed, 'csrfToken', 'different-token')).toBe(false);
    expect(Reflect.set(exposed, 'principal', { tenantId: 'other', subjectId: 'other', sessionId: 'other' })).toBe(false);
    expect(Reflect.set(exposed.principal, 'tenantId', 'other-tenant')).toBe(false);
    expect(Reflect.set(exposed.principal, 'subjectId', 'other-subject')).toBe(false);
    expect(Reflect.set(exposed.principal, 'sessionId', 'other-session')).toBe(false);
    expect(sessions.get(expected.id)).toEqual(expected);

    const rotated = sessions.rotate(expected.id)!;
    expect(sessions.get(expected.id)).toBeNull();
    expect(rotated.principal).toEqual({ ...expected.principal, sessionId: rotated.id });
    expect(Reflect.set(rotated.principal, 'tenantId', 'other-tenant')).toBe(false);
    expect(Reflect.set(rotated, 'csrfToken', 'different-token')).toBe(false);
    expect(sessions.get(rotated.id)).toEqual(rotated);
  });

  it('owns its principal snapshot without freezing or modifying the caller object', () => {
    const principal = { tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: 'caller-session' };
    const sessions = new InMemorySessionStore();
    const session = sessions.create(principal);

    expect(Object.isFrozen(principal)).toBe(false);
    expect(principal.sessionId).toBe('caller-session');
    principal.tenantId = 'changed-by-caller';
    principal.subjectId = 'changed-by-caller';
    expect(sessions.get(session.id)?.principal).toEqual({ tenantId: 'tenant_1', subjectId: 'subject_1', sessionId: session.id });

    sessions.revoke(session.id);
    expect(sessions.get(session.id)).toBeNull();
    expect(sessions.rotate(session.id)).toBeNull();
  });
});
