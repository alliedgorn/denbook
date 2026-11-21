// T#1016 — who an audit_log row is attributed to.
//
// Trusted sources set a plain actor: a bearer token, Gorn's session cookie, or a
// server-set guest session. Anything else is a CLAIM by the caller (a path segment
// on path-identity routes, or the x-beast header). Claims are kept for forensics
// but prefixed, so a bearer-less request can never write a real actor name such
// as "gorn" into the column. actor_type stays "unknown" for claims.

export interface AuditActorInput {
  tokenActor?: string;
  tokenActorType?: string;
  hasSession: boolean;
  guestUsername?: string | null;
  isGuest: boolean;
  path: string;
  xBeast?: string | null;
}

export interface AuditActor {
  actor: string;
  actorType: string;
}

const PATH_IDENTITY = /\/api\/(?:dm|schedules)\/(?!messages|dashboard|due|pending)([a-z][\w-]*)/i;

/** Keep a claimed name short and printable; it is caller-controlled. */
function cleanClaim(s: string): string {
  return s.replace(/[^\w.@-]/g, '').slice(0, 64) || '?';
}

export function deriveAuditActor(i: AuditActorInput): AuditActor {
  if (i.tokenActor) return { actor: i.tokenActor, actorType: i.tokenActorType || 'unknown' };
  if (i.hasSession) return { actor: 'gorn', actorType: 'human' };
  if (i.isGuest && i.guestUsername) return { actor: `[Guest] ${i.guestUsername}`, actorType: 'guest' };

  const pathMatch = i.path.match(PATH_IDENTITY);
  if (pathMatch) return { actor: `path:${cleanClaim(pathMatch[1])}`, actorType: 'unknown' };

  const claimed = (i.xBeast || '').trim();
  if (claimed) return { actor: `header:${cleanClaim(claimed)}`, actorType: 'unknown' };

  return { actor: 'unknown', actorType: 'unknown' };
}
