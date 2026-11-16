// T#859 / T#857 / T#846: one trusted answer to "who is calling".
//
// Topology this relies on (verified live 2026-11-16, #20 31902):
// - The server binds loopback only, so the socket peer is always loopback.
// - Caddy is the only remote path. Its denbook.online block sets
//   X-Forwarded-For to {remote_host}, one value, overwriting anything the
//   client sent. Caddy does NOT set X-Real-IP, so on the edge path X-Real-IP is
//   pure client input.
//
// Rules:
// - clientIp: the socket peer, unless the peer is loopback and X-Forwarded-For
//   is present, in which case the RIGHTMOST entry (the one the proxy wrote).
//   X-Real-IP is never read. A client can put anything on the left of XFF; it
//   cannot change what the proxy appends or writes last.
// - isLocalRequest: the peer is loopback AND no forwarding header is present.
//   Anything that came through a proxy is remote, whatever address it claims.
//   (A local process can still send forwarding headers, but that only makes it
//   look remote, never local.)
//
// The socket peer comes from Bun's server.requestIP, passed to Hono as env.ip
// (server.ts app.fetch). In-process tests have no socket; an unknown peer is
// treated as loopback, which keeps the old default and still refuses anything
// that carries a forwarding header.

import type { Context } from 'hono';

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'];

export function isLoopback(ip: string | undefined | null): boolean {
  if (!ip) return false;
  const a = ip.trim().toLowerCase();
  if (a === '::1' || a === 'localhost') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

type HeaderGet = (name: string) => string | null | undefined;

function peerIsLoopback(peer: string | undefined | null): boolean {
  return !peer || isLoopback(peer);
}

function rightmostXff(get: HeaderGet): string {
  const xff = get('x-forwarded-for');
  if (!xff) return '';
  const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function clientIpFrom(get: HeaderGet, peer: string | undefined | null, fallback = 'local'): string {
  if (peerIsLoopback(peer)) {
    const forwarded = rightmostXff(get);
    if (forwarded) return forwarded;
  }
  return peer || fallback;
}

export function isLocalFrom(get: HeaderGet, peer: string | undefined | null): boolean {
  if (!peerIsLoopback(peer)) return false;
  return !FORWARDING_HEADERS.some(h => get(h));
}

function peerOf(c: Context): string | undefined {
  return (c.env as any)?.ip;
}

export function clientIp(c: Context, fallback = 'local'): string {
  return clientIpFrom(n => c.req.header(n), peerOf(c), fallback);
}

export function isLocalRequest(c: Context): boolean {
  return isLocalFrom(n => c.req.header(n), peerOf(c));
}
