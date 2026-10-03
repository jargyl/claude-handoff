// Who may call what.
//
//  - Requests from this machine (loopback) are trusted, but the Host header must
//    be a loopback name (stops DNS-rebinding pages) and state-changing requests
//    must be same-origin and carry the X-Handoff header (stops CSRF from any
//    website open in your browser).
//  - Requests from the network only work when LAN sharing is on, and need the
//    access token (Authorization: Bearer, or the cookie set by /api/auth/login).
//    Remote callers get read access plus the device-to-device endpoints; they
//    can't change settings, browse folders, open terminals or import directly.

import crypto from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { SettingsStore } from './config.js';

export const TOKEN_COOKIE = 'handoff_token';

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1' || addr.startsWith('::ffff:127.');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostName(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0]!.toLowerCase();
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export type Access = 'local' | 'remote';

declare module 'hono' {
  interface ContextVariableMap {
    access: Access;
  }
}

/** Routes a remote (token-holding) caller may use besides GETs. */
const REMOTE_WRITE_ALLOW = [/^\/api\/peer\/inbox$/, /^\/api\/peer\/prefix-hashes$/, /^\/api\/auth\/(login|logout)$/, /^\/api\/peer\/pair$/];
/** GETs a remote caller may NOT use. */
const REMOTE_READ_DENY = [/^\/api\/settings/, /^\/api\/fs\//, /^\/api\/devices/, /^\/api\/sync/, /^\/api\/history/, /^\/api\/imports/, /^\/api\/trash/];
/** Reachable without a token even from the network (pairing uses a short code instead). */
const PUBLIC_REMOTE = [/^\/api\/peer\/pair$/, /^\/api\/peer\/hello$/, /^\/api\/auth\/login$/];

export function securityMiddleware(settings: SettingsStore, remoteAddr: (c: Context) => string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const p = url.pathname;
    const method = c.req.method.toUpperCase();
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const addr = remoteAddr(c);
    const local = isLoopback(addr);
    const host = c.req.header('host');

    if (local) {
      if (!LOOPBACK_HOSTS.has(hostName(host))) {
        // A browser on this machine reaching us through another hostname: only OK with LAN sharing + token
        if (!settings.get().lan.enabled) return c.text('Forbidden host', 403);
      } else {
        c.set('access', 'local');
        if (mutating && p.startsWith('/api/')) {
          const origin = c.req.header('origin');
          if (origin) {
            let oh = '';
            try {
              oh = hostName(new URL(origin).host);
            } catch {
              return c.text('Bad origin', 403);
            }
            if (!LOOPBACK_HOSTS.has(oh)) return c.text('Cross-origin request blocked', 403);
          }
          if (!c.req.header('x-handoff') && !c.req.header('authorization')) return c.text('Missing X-Handoff header', 403);
        }
        return next();
      }
    }

    // ---- remote
    const s = settings.get();
    if (!s.lan.enabled) return c.text('LAN sharing is off on this device', 403);
    if (!p.startsWith('/api/')) return next(); // static UI assets carry no data
    c.set('access', 'remote');
    if (PUBLIC_REMOTE.some((r) => r.test(p))) return next();
    const auth = c.req.header('authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    const token = bearer ?? getCookie(c, TOKEN_COOKIE);
    if (!token || !tokensEqual(token, s.lan.token)) return c.json({ error: 'unauthorized', message: 'Access token required' }, 401);
    if (mutating) {
      if (!REMOTE_WRITE_ALLOW.some((r) => r.test(p))) return c.json({ error: 'forbidden', message: 'Not allowed from another device' }, 403);
      const origin = c.req.header('origin');
      if (origin && !bearer) {
        try {
          if (new URL(origin).host !== host) return c.text('Cross-origin request blocked', 403);
        } catch {
          return c.text('Bad origin', 403);
        }
      }
    } else if (REMOTE_READ_DENY.some((r) => r.test(p))) {
      return c.json({ error: 'forbidden', message: 'Only available on the device itself' }, 403);
    }
    return next();
  };
}

/** Simple fixed-window rate limiter for pairing attempts. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}
