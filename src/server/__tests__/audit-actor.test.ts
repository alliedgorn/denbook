// T#1016 — a bearer-less caller must never write a real actor name into audit_log.
import { describe, it, expect } from 'bun:test';
import { deriveAuditActor } from '../audit-actor.ts';

const base = { hasSession: false, isGuest: false, path: '/api/tasks' };

describe('deriveAuditActor', () => {
  it('bearer token actor wins, unprefixed', () => {
    expect(deriveAuditActor({ ...base, tokenActor: 'karo', tokenActorType: 'beast', xBeast: 'gorn' }))
      .toEqual({ actor: 'karo', actorType: 'beast' });
  });

  it('owner session is gorn / human, even with an x-beast header', () => {
    expect(deriveAuditActor({ ...base, hasSession: true, xBeast: 'pip' }))
      .toEqual({ actor: 'gorn', actorType: 'human' });
  });

  it('guest session is server-set', () => {
    expect(deriveAuditActor({ ...base, isGuest: true, guestUsername: 'mink' }))
      .toEqual({ actor: '[Guest] mink', actorType: 'guest' });
  });

  it('x-beast: gorn on a bearer-less request is a prefixed claim, never "gorn"', () => {
    const r = deriveAuditActor({ ...base, xBeast: 'gorn' });
    expect(r).toEqual({ actor: 'header:gorn', actorType: 'unknown' });
    expect(r.actor).not.toBe('gorn');
  });

  it('path-identity claim is prefixed too (/api/dm/gorn/...)', () => {
    expect(deriveAuditActor({ ...base, path: '/api/dm/gorn/karo' }))
      .toEqual({ actor: 'path:gorn', actorType: 'unknown' });
    expect(deriveAuditActor({ ...base, path: '/api/schedules/pip' }))
      .toEqual({ actor: 'path:pip', actorType: 'unknown' });
  });

  it('reserved dm/schedules subpaths are not identities', () => {
    for (const p of ['/api/dm/messages/5', '/api/dm/dashboard', '/api/schedules/due']) {
      expect(deriveAuditActor({ ...base, path: p }).actor).toBe('unknown');
    }
  });

  it('claimed names are cleaned and capped (caller-controlled)', () => {
    const r = deriveAuditActor({ ...base, xBeast: 'gorn\n[Scheduler] x' + 'a'.repeat(200) });
    expect(r.actor.startsWith('header:gorn')).toBe(true);
    expect(r.actor).not.toContain('\n');
    expect(r.actor).not.toContain('[');
    expect(r.actor.length).toBeLessThanOrEqual('header:'.length + 64);
  });

  it('no identity at all is unknown', () => {
    expect(deriveAuditActor({ ...base })).toEqual({ actor: 'unknown', actorType: 'unknown' });
    expect(deriveAuditActor({ ...base, xBeast: '   ' })).toEqual({ actor: 'unknown', actorType: 'unknown' });
  });
});
