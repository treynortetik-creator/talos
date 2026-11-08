// MCP Apps in the full stack (MCP-APPS-SPEC M6.2): the built relay and web app, the real bridge with TALOS_APP_APPS=1, a
// catalog written by the real scan module from the REAL probe and reference servers (apps/bridge/test/apps/e2e-scan.ts, run
// under Bun), and FakeClaude's agent driver holding real MCP clients to those servers and running the real hook command lines
// read from the scan-written settings.local.json. Only the model is scripted. The scan's Keychain is an in-memory double, so
// the owner's login Keychain is never touched (which is also why the bridge's own HTTP connection, the direct path, is not
// driven here: the live bridge has no Keychain seam and must not get one; see bridge tests and docs/APPS.md).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Frame, Page } from '@playwright/test'
import { buildAppCsp } from '@talos-app/protocol'
import type { ChannelNote, FakeClaude } from '@talos-app/testkit'
import { BRIDGE_DIR, ROOT } from './paths.ts'
import type { Stack } from './stack.ts'

const SCAN = join(BRIDGE_DIR, 'test', 'apps', 'e2e-scan.ts')
const PROBE = join(ROOT, 'packages', 'testkit', 'fixtures', 'apps-probe-server', 'server.mjs')
const REF = (pkg: string) => join(ROOT, 'e2e', 'node_modules', '@modelcontextprotocol', pkg, 'dist', 'index.js')

export type AppServerSpec = {
  /** The name Claude Code reports; also the `mcp__<name>__` tool prefix. */
  name: string
  kind: 'probe' | 'clock' | 'monitor'
  label: string
  show?: 'auto' | 'ask'
  /** Probe only: PROBE_GEN / PROBE_DRIFT for the next scan. */
  env?: Record<string, string>
  /** Answer the approval question n (default y). */
  approve?: boolean
}

/** One scripted `talos-app apps scan`: returns what it printed. Throws with the output if the scan fails. */
async function runScanScript(args: Record<string, unknown>): Promise<{ out: string[]; asked: string[] }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', SCAN, JSON.stringify(args)], {
      cwd: BRIDGE_DIR,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('exit', (code) => {
      const last = out.trim().split('\n').at(-1) ?? ''
      try {
        const j = JSON.parse(last) as { ok: boolean; out: string[]; asked: string[]; error?: string }
        if (code === 0 && j.ok) return resolve(j)
        reject(new Error(`scan failed: ${j.error ?? last} ${err}`))
      } catch {
        reject(new Error(`scan failed (exit ${code}): ${out} ${err}`))
      }
    })
  })
}

/**
 * Scans the given servers and starts the bridge with the apps switch on and the agent driver attached. Call BEFORE the device
 * is enrolled is fine: the bridge only needs to be up; `enrollDevice` pins the phone afterwards.
 */
export async function startApps(
  stack: Stack,
  opts: {
    servers: AppServerSpec[]
    /** Bridge env on top (TALOS_APP_APPS=1 is the default; pass '' to switch the feature off). */
    env?: Record<string, string>
    /** Don't start the bridge (a test that starts it itself). */
    noBridge?: boolean
    /** Claude Code version the scan sees. */
    version?: string
    /** FakeClaude answers every text and card action by itself (default false: apps tests script the agent). */
    autoReply?: boolean
  },
) {
  const scratch = mkdtempSync(join(process.env.E2E_TMP_ROOT ?? tmpdir(), 'talos-e2e-apps-'))
  const agentDir = join(scratch, 'agent')
  const emptyHome = join(scratch, 'empty-home')
  const sessionDir = join(scratch, 'session')
  const probeLog = join(scratch, 'probe.jsonl')
  for (const d of [agentDir, emptyHome, sessionDir]) mkdirSync(d, { recursive: true })
  const settingsPath = join(agentDir, '.claude', 'settings.local.json')

  const scan = async (servers: AppServerSpec[] = opts.servers, over: { version?: string; check?: boolean } = {}) =>
    await runScanScript({
      home: stack.home,
      keychainFile: join(scratch, 'keychain-double.json'),
      agentDir,
      relayUrl: stack.origin,
      version: over.version ?? opts.version ?? '2.1.312',
      ...(over.check ? { check: true } : {}),
      servers: servers.map((s) => ({
        name: s.name,
        kind: s.kind,
        transport: 'stdio',
        label: s.label,
        ...(s.show ? { show: s.show } : {}),
        ...(s.approve === false ? { approve: false } : {}),
        env: s.kind === 'probe' ? { ...(s.env ?? {}) } : {},
      })),
    })
  const first = await scan()

  const driverServers = opts.servers.map((s) => ({
    name: s.name,
    source: 'local',
    command: 'node',
    args:
      s.kind === 'probe'
        ? [PROBE]
        : [REF(s.kind === 'clock' ? 'server-basic-vanillajs' : 'server-system-monitor'), '--stdio'],
    env: (s.kind === 'probe' ? { PROBE_LOG: probeLog } : {}) as Record<string, string>,
  }))
  // the hooks the agent runs share the Mac's clock with the bridge (they stamp claims and tombstones the bridge later reads)
  const hookEnv = {
    TALOS_APP_BRIDGE: '1',
    TALOS_APP_APPS: '1',
    TALOS_APP_HOME: stack.home,
    HOME: emptyHome,
    ...stack.clockEnv,
  }

  let claude: FakeClaude | undefined
  const start = async (env: Record<string, string> = {}): Promise<FakeClaude> => {
    claude = await stack.startBridge({
      clientVersion: opts.version ?? '2.1.312',
      autoReply: opts.autoReply ?? false,
      env: { HOME: emptyHome, TALOS_APP_APPS: '1', ...(opts.env ?? {}), ...env },
      agentDriver: {
        settingsPath,
        servers: driverServers,
        env: hookEnv,
        cwd: BRIDGE_DIR,
        sessionDir,
      },
    })
    return claude
  }
  if (!opts.noBridge) await start()

  const probeCalls = (): Array<{ event: string; tool?: string; arguments?: Record<string, unknown> }> => {
    try {
      return readFileSync(probeLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === 'tools/call' && l.tool !== 'show_widget') // show_widget is the agent's own call that put the view up
    } catch {
      return []
    }
  }
  const driver = () => {
    const d = (claude ?? stack.claude).driver
    if (!d) throw new Error('the bridge has no agent driver')
    return d
  }
  const notes = (kind: string): ChannelNote[] =>
    (claude ?? stack.claude).notifications.filter((n) => n.meta.kind === kind)

  /**
   * The agent shows a view to the owner: calls the UI tool (hooks and all), then app_show with the capture id the post hook
   * handed it. Returns the tool-use id and what app_show said.
   */
  async function show(server: string, tool: string, args: Record<string, unknown> = {}, caption?: string) {
    const call = await driver().callTool(server, tool, args)
    const r = await (claude ?? stack.claude).callTool('app_show', {
      thread_id: 'general',
      capture_id: call.toolUseId,
      ...(caption ? { caption } : {}),
    })
    const text = r.content[0]?.text ?? ''
    return { call, text, isError: r.isError === true, viewId: /view (av_[0-9A-HJKMNP-TV-Z]{26})/.exec(text)?.[1] }
  }

  return {
    scratch,
    agentDir,
    settingsPath,
    probeLog,
    first,
    scan,
    start,
    show,
    driver,
    notes,
    probeCalls,
    catalog: () =>
      JSON.parse(readFileSync(join(stack.home, 'apps', 'catalog.json'), 'utf8')) as {
        servers: Array<{
          server: string
          resources: Array<{ uri: string; approval_key: string; state: string; csp: unknown }>
        }>
      },
    /** Rewrites the file the scan wrote, e.g. to plant a hostile edit between scans. */
    writeCatalog: (c: unknown) =>
      writeFileSync(join(stack.home, 'apps', 'catalog.json'), JSON.stringify(c), { mode: 0o600 }),
  }
}

// ---- browser side ---------------------------------------------------------------------------------------------------------

export const appFrame = (page: Page, title: string) => page.frameLocator(`iframe[title="${title}"]`)

/** The Playwright Frame of the app's iframe (for `evaluate`; the frame is an opaque origin, only CDP can reach in). */
export async function frameByTitle(page: Page, title: string): Promise<Frame> {
  const handle = await page.locator(`iframe[title="${title}"]`).elementHandle()
  if (!handle) throw new Error(`no iframe titled ${title}`)
  const f = await handle.contentFrame()
  if (!f) throw new Error('the iframe has no content frame yet')
  return f
}

/** What `/media/:id/app` must send for a catalog CSP: the sandbox directive plus buildAppCsp, exactly. */
export function expectedAppCsp(csp: unknown): string {
  return `sandbox allow-scripts; ${buildAppCsp(csp as Parameters<typeof buildAppCsp>[0])}`
}

export type Rpc = {
  id?: number
  result?: unknown
  error?: { code: number; message: string; data?: { talos?: string } }
}

/**
 * The view sends one JSON-RPC request to the host and waits for the answer (no 3 s cap like the probe's own `call`, since a card
 * can wait for the owner). Returns a promise; await it when the scenario says the answer is due.
 */
export function viewRequest(frame: Frame, method: string, params: unknown): Promise<Rpc> {
  return frame.evaluate(
    ([m, p]) =>
      new Promise<Rpc>((resolve) => {
        const id = 100000 + Math.floor(Math.random() * 900000)
        const on = (e: MessageEvent) => {
          if (e.data && e.data.id === id && !e.data.method) {
            removeEventListener('message', on)
            resolve(e.data)
          }
        }
        addEventListener('message', on)
        ;(window as unknown as { __probe: { send(m: unknown): void } }).__probe.send({ id, method: m, params: p })
      }),
    [method, params] as const,
  )
}

/** The Talos error code an answer carries (`data.talos`), if it is an error. */
export const talosCode = (r: Rpc): string | undefined => r.error?.data?.talos

/** A tap inside the view (a real click on its frame): gives the page a user activation for the next ~5 s. */
export async function tapView(page: Page, title: string): Promise<void> {
  await page.locator(`iframe[title="${title}"]`).click({ position: { x: 3, y: 3 } }) // the page margin: no control of the view is hit
}
