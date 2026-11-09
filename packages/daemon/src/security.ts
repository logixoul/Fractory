import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/**
 * Daemon request security (spec "Daemon security", non-negotiable):
 *  - only 127.0.0.1 (bind is enforced in server.ts)
 *  - Host must be 127.0.0.1:<port> or localhost:<port>   (DNS rebinding)
 *  - Origin, when present, must be the daemon's own origin; Sec-Fetch-Site cross-site is refused (CSRF)
 *  - a per-launch random token on every request: Authorization: Bearer, ?token= (initial GUI
 *    URL and EventSource), or the HttpOnly SameSite=Strict cookie set from a valid ?token=
 *  - state-changing requests authenticated only by cookie must carry our Origin
 *  - no CORS headers at all; preflights are refused
 */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenEquals(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SecurityOptions {
  token: string;
  /** Port the server is listening on (known after listen). */
  port: () => number;
}

const deny = (c: Context, status: 401 | 403 | 405, error: string) => c.json({ error }, status);

export const cookieName = (port: number) => `fractory_${port}`;

export function security(o: SecurityOptions): MiddlewareHandler {
  return async (c, next) => {
    const port = o.port();
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

    const host = c.req.header("host");
    if (!host || !allowedHosts.has(host.toLowerCase())) return deny(c, 403, "host not allowed");

    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) return deny(c, 403, "origin not allowed");
    const site = c.req.header("sec-fetch-site");
    if (site === "cross-site" || site === "same-site") return deny(c, 403, "cross-site request refused");

    if (c.req.method === "OPTIONS") return deny(c, 405, "CORS preflight is not supported");

    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const query = c.req.query("token");
    const cookie = getCookie(c, cookieName(port));
    const viaHeader = tokenEquals(bearer, o.token);
    const viaQuery = tokenEquals(query, o.token);
    const viaCookie = tokenEquals(cookie, o.token);
    if (!viaHeader && !viaQuery && !viaCookie) return deny(c, 401, "missing or invalid token");

    const mutating = !["GET", "HEAD"].includes(c.req.method);
    if (mutating && !viaHeader && origin === undefined) return deny(c, 403, "state-changing requests need an Authorization header or our Origin");

    // The GUI is opened with ?token=…; afterwards its assets and API calls ride on the cookie.
    if (viaQuery && !viaCookie) {
      setCookie(c, cookieName(port), o.token, { httpOnly: true, sameSite: "Strict", path: "/" });
    }
    await next();
    c.header("Cache-Control", "no-store");
  };
}

/** Headers on every response. No Access-Control-* header is ever sent. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer"); // the token may be in the URL
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
};
