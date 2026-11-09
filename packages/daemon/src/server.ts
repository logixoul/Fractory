import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Redactor, RunStore, createWorkers, defaultConfigDir, defaultDataDir } from "@fractory/core";
import { createApp } from "./app.js";
import { DriverPool, type WorkerFactory } from "./drivers.js";
import { AuthCodes, newToken } from "./security.js";

/** The daemon only ever listens on loopback IPv4 (spec: bind to 127.0.0.1 only). */
export const DAEMON_HOST = "127.0.0.1";

export interface DaemonOptions {
  dataDir?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 0 = any free port. */
  port?: number;
  webDir?: string;
  /** Test hook (default: real adapters). */
  workers?: WorkerFactory;
  tailMs?: number;
  heartbeatMs?: number;
  /** Test hook for the login-code clock. */
  now?: () => number;
}

export interface Daemon {
  url: string;
  /** First GUI link: carries a single-use login code (60 s), never the token. */
  guiUrl: string;
  /** Issues a fresh single-use GUI link. */
  newGuiUrl(): string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export async function startDaemon(o: DaemonOptions = {}): Promise<Daemon> {
  const env = o.env ?? process.env;
  const dataDir = o.dataDir ?? defaultDataDir(env);
  const configDir = o.configDir ?? defaultConfigDir(env);
  const redactor = Redactor.fromEnv(env);
  const store = new RunStore(dataDir, redactor);
  const factory: WorkerFactory =
    o.workers ?? ((config, ctx) => createWorkers(config, { dataDir: ctx.dataDir, redactor: ctx.redactor, baseDir: ctx.repo, env }));
  const pool = new DriverPool(store, dataDir, redactor, factory);
  const token = newToken();
  const codes = new AuthCodes(o.now);
  let port = 0;
  const app = createApp({
    store,
    pool,
    dataDir,
    configDir,
    token,
    codes,
    port: () => port,
    ...(o.webDir ? { webDir: o.webDir } : {}),
    ...(o.tailMs !== undefined ? { tailMs: o.tailMs } : {}),
    ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
  });
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: DAEMON_HOST, port: o.port ?? 0 }, () => resolve(s));
    s.once("error", reject);
  });
  const addr = server.address() as AddressInfo;
  if (addr.address !== DAEMON_HOST) {
    server.close();
    throw new Error(`refusing to serve on ${addr.address}`);
  }
  port = addr.port;
  const url = `http://${DAEMON_HOST}:${port}`;
  return {
    url,
    guiUrl: `${url}/auth?code=${codes.issue()}`,
    newGuiUrl: () => `${url}/auth?code=${codes.issue()}`,
    token,
    port,
    async close() {
      await pool.stopAll();
      await new Promise<void>((r) => {
        server.close(() => r());
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}
