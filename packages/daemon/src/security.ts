import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/**
 * Daemon request security (spec "Daemon security", non-negotiable):
 *  - only 127.0.0.1 (bind is enforced in server.ts)
 *  - Host must be 127.0.0.1:<port> or localhost:<port>   (DNS rebinding)
 *  - Origin, when present, must be the daemon's own origin; Sec-Fetch-Site cross-site is refused (CSRF)
 *  - a per-launch random token on every request, as Authorization: Bearer or as the HttpOnly
 *    SameSite=Strict cookie. The token never appears in a URL: the GUI link carries a
 *    single-use code (60 s) that GET /auth exchanges for the cookie, then redirects to /.
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

export const AUTH_CODE_TTL_MS = 60_000;

/** Single-use login codes for the GUI link (spec review item 7). */
export class AuthCodes {
  readonly #codes = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    for (const [c, exp] of this.#codes) if (exp <= this.now()) this.#codes.delete(c);
    const code = randomBytes(24).toString("base64url");
    this.#codes.set(code, this.now() + AUTH_CODE_TTL_MS);
    return code;
  }

  /** True once per issued code, within its lifetime. */
  consume(code: string | undefined): boolean {
    if (!code) return false;
    for (const [c, exp] of this.#codes) {
      if (tokenEquals(code, c)) {
        this.#codes.delete(c);
        return exp > this.now();
      }
    }
    return false;
  }
}

export interface SecurityOptions {
  token: string;
  codes: AuthCodes;
  /** Port the server is listening on (known after listen). */
  port: () => number;
}

const deny = (c: Context, status: 401 | 403 | 405, error: string) => c.json({ error }, status);

export const cookieName = (port: number) => `fractory_${port}`;

const EXPIRED_PAGE =
  "<!doctype html><title>fractory</title><p>This link has expired or was already used. Press Enter in the terminal running <code>fractory serve</code> to get a new one.</p>";

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

    // GUI login: exchange a single-use code for the cookie, then leave the URL behind.
    if (c.req.path === "/auth" && c.req.method === "GET") {
      if (!o.codes.consume(c.req.query("code"))) return c.html(EXPIRED_PAGE, 401);
      setCookie(c, cookieName(port), o.token, { httpOnly: true, sameSite: "Strict", path: "/" });
      c.header("Cache-Control", "no-store");
      return c.redirect("/", 303);
    }

    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const viaHeader = tokenEquals(bearer, o.token);
    const viaCookie = tokenEquals(getCookie(c, cookieName(port)), o.token);
    if (!viaHeader && !viaCookie) return deny(c, 401, "missing or invalid token");

    const mutating = !["GET", "HEAD"].includes(c.req.method);
    if (mutating && !viaHeader && origin === undefined) return deny(c, 403, "state-changing requests need an Authorization header or our Origin");

    await next();
    c.header("Cache-Control", "no-store");
  };
}

/** Headers on every response. No Access-Control-* header is ever sent. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
};
