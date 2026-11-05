// Relay entry point: env -> services -> migrations (inside openDatabase) -> modules -> HTTP + WebSocket server.
// Importing this file has no side effects; `main()` runs only when the file is the process entry point.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { MAX_FRAME_BYTES } from '@talos-app/protocol'
import { WebSocketServer } from 'ws'
import { fileFatalProblem, installFatalHandlers } from './core/problems.ts'
import { type CreateOptions, createRelayServices, runtimeOf } from './core/runtime.ts'
import { loadEnv, type RelayEnv } from './env.ts'
import { registerModules } from './modules.ts'
import { buildApp } from './routes.ts'
import type { RelayServices } from './services.ts'
import { shutdownVoice } from './voice/index.ts'

export { loadEnv } from './env.ts'
export { migrate } from './migrate.ts'

export type RunningRelay = {
  services: RelayServices
  /** Port actually bound (PORT=0 picks a free one). */
  port: number
  /** The node server, for tests that look at its limits. */
  http: import('node:http').Server
  stop(): Promise<void>
}

/** Above the upload guard's 10 minute ceiling, so the guard (408) always speaks first. */
export const REQUEST_TIMEOUT_MS = 11 * 60_000

/** Boots a relay. `registerModules` runs the core, auth, hooks and voice registrations. */
export async function startRelay(
  opts: Partial<Omit<CreateOptions, 'env'>> & {
    env: RelayEnv
    host?: string
    /** Overrides env.PORT; 0 picks a free port (the env schema's minimum is 1, so tests use this). */
    port?: number
  },
): Promise<RunningRelay> {
  const services = createRelayServices(opts)
  try {
    await registerModules(services)
  } catch (e) {
    services.db.close()
    throw e
  }
  const app = buildApp(services)
  // The last run's fatal error, if it left one, goes to the Mac now. A failure here must not stop the relay booting.
  await fileFatalProblem(services).catch((e) =>
    services.log.warn({ err: (e as Error).name }, 'fatal problem not filed'),
  )
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const server = serve({
    fetch: app.fetch,
    port: opts.port ?? services.env.PORT,
    hostname: opts.host ?? '0.0.0.0',
    createServer,
    // Node's default `requestTimeout` (300 s) counts the WHOLE request however steadily bytes flow, and answers 400 on
    // expiry, which cut a slow 50 MB upload short of the body guard's 10 min ceiling (core/body-guard.ts). Kept as a
    // backstop for every other route, just above that ceiling.
    serverOptions: { requestTimeout: REQUEST_TIMEOUT_MS },
    websocket: { server: wss },
  })
  // Every socket needs an 'error' listener for as long as it lives. Node drops the HTTP server's own on 'upgrade', and
  // @hono/node-server answers a refused upgrade (403/401/429) by writing to the raw socket: a client reset right after
  // that was an uncaught ECONNRESET that killed the whole process (bughunt D). Tracked so shutdown can destroy them too.
  const http = server as unknown as import('node:http').Server
  const sockets = new Set<import('node:net').Socket>()
  http.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => s.destroy())
  })
  // Having a 'clientError' listener replaces node's default answer, so give the same one.
  http.on('clientError', (_err, s) => {
    if (s.writable) s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    s.destroy()
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : services.env.PORT
  services.log.info({ port }, 'relay listening')
  return {
    services,
    port,
    http,
    async stop() {
      shutdownVoice(services)
      runtimeOf(services).stop()
      // A client that never finished its handshake, or a phone that went half-open, would otherwise keep close() waiting
      // until the platform's SIGKILL. Terminate every websocket and destroy every socket, with a deadline as the backstop.
      for (const c of wss.clients) c.terminate()
      wss.close()
      await Promise.race([
        new Promise<void>((resolve) => {
          http.close(() => resolve())
          http.closeAllConnections?.()
          for (const s of sockets) s.destroy()
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
      ])
      try {
        services.db.pragma('wal_checkpoint(TRUNCATE)')
        services.db.close()
      } catch {
        // already closed
      }
    },
  }
}

async function main(): Promise<void> {
  const env = loadEnv()
  const webDir = process.env.TALOS_WEB_DIR
  installFatalHandlers({ dataDir: env.DATA_DIR })
  const relay = await startRelay({ env, ...(webDir ? { webDir } : {}) })
  const shutdown = () => {
    setTimeout(() => process.exit(1), 10_000).unref() // never wait for the platform's SIGKILL
    void relay.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
