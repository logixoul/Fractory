// Same-origin calls only. Authentication rides on the HttpOnly cookie the daemon set when the
// GUI was opened with ?token=; the browser adds our Origin to POSTs, which the daemon requires.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function check(r: Response): Promise<Response> {
  if (r.ok) return r;
  let msg = `${r.status} ${r.statusText}`;
  try {
    const j = (await r.json()) as { error?: string };
    if (j.error) msg = j.error;
  } catch {
    /* not json */
  }
  throw new ApiError(r.status, msg);
}

export async function getJson<T>(path: string): Promise<T> {
  return (await (await check(await fetch(path, { credentials: "same-origin" }))).json()) as T;
}

export async function getText(path: string): Promise<string> {
  return (await check(await fetch(path, { credentials: "same-origin" }))).text();
}

export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await (await check(r)).json()) as T;
}

export const runFile = (runId: string, file: string) => `/api/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(file)}`;

/** Removes ?token= from the address bar right after load (the cookie now authenticates us). */
export function stripTokenFromUrl(loc: Location = location, hist: History = history): void {
  const u = new URL(loc.href);
  if (!u.searchParams.has("token")) return;
  u.searchParams.delete("token");
  hist.replaceState(null, "", u.pathname + (u.search ? u.search : "") + u.hash);
}
