import type { Principal } from './order.ts';

export const SESSION_COOKIE = 'bc_session';

export type Session = Readonly<{
  id: string;
  principal: Principal;
  csrfToken: string;
}>;

export interface SessionStore {
  get(id: string): Session | null;
  create(principal: Principal): Session;
  rotate(id: string): Session | null;
  revoke(id: string): void;
}

export interface CredentialStore {
  verify(tenantId: string, subjectId: string, password: string): Promise<Principal | null>;
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + Buffer.from(bytes).toString('base64url');
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  get(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  create(principal: Principal): Session {
    const id = randomToken('sess_');
    const session: Session = {
      id,
      principal: { ...principal, sessionId: id },
      csrfToken: randomToken('csrf_'),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  rotate(id: string): Session | null {
    const current = this.sessions.get(id);
    if (current === undefined) return null;
    this.sessions.delete(id);
    return this.create(current.principal);
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }
}
