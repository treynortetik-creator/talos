// The capability report and the version check (docs/CLAUDE-CODE.md C2.3, review #8). The app shows a control only when
// its capability is reported, so this fails closed: a Claude Code below the floor reports nothing, and a method that is
// not there (the API is early access and moves between releases) takes its capability with it.
//
// The engine's own static check forbids reading a method as a value (`typeof $.turn.abort`), so "is it there" is a PROBE:
// a harmless call. A probe that returns, or throws anything but "is not a function", found the method. Methods with a
// side effect need a probe that cannot do harm: register.ts uses a call the engine must reject (turn.abort and
// command.run with a made-up id/name; a normal Error means "the method is there"). session.compact has none (a real
// call compacts), so it is reported once the version check passes; SMOKE must confirm it on a real Mac.

export const MIN_VERSION = '2.1.304'

export type Capability =
  | 'stop'
  | 'compact'
  | 'command'
  | 'clear'
  | 'model'
  | 'effort'
  | 'inventory'
  | 'permission_close'
  | 'sessions'
  | 'agents'
  | 'agent_stop'

/**
 * What this build of the mod can DO. A capability is reported only when the mod has the code behind it AND its probe
 * finds the engine method. Inventory and the C3.4 closer (WP-C2); stop, compact, command, clear, model and effort
 * (WP-C3, hooks/lib/controls.ts); WP-C7 adds sessions. WP-A1 (docs/SUBAGENTS.md): `agents` (the collector in
 * hooks/lib/agents.ts) and `agent_stop` (`TaskStop` from controls.ts). These two travel mod -> bridge only: the bridge
 * publishes session.state with main's nine (wireSessionState), and the panel's facts ride in session.agents. Reporting a capability the mod cannot act on would let the
 * bridge queue a control nobody runs.
 */
export const IMPLEMENTED: ReadonlySet<Capability> = new Set<Capability>([
  'inventory',
  'permission_close',
  'stop',
  'compact',
  'command',
  'clear',
  'model',
  'effort',
  'agents',
  'agent_stop',
])

/** Engine method (as `noun.event`) to the capabilities it gives. */
export const METHOD_CAPS: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ['turn.abort', ['stop']],
  ['session.compact', ['compact']],
  ['command.run', ['command', 'clear', 'model', 'effort']],
  ['command.list', ['inventory']],
  ['tool.check', ['permission_close']],
  ['agent.list', ['sessions', 'agents']],
  // probed with `$.tool.call({ tool: 'TaskStop', task_id: '__talos_probe__' })`, which the tool must refuse (SMOKE S-A6)
  ['tool.call', ['agent_stop']],
]

/** Calls the link itself makes. A core probe that cannot complete keeps the mod silent. */
export const CORE_PROBES = [
  'tool.list',
  'command.list',
  'config.list',
  'session.id',
  'session.usage',
  'session.version',
] as const
export type CoreName = (typeof CORE_PROBES)[number]

export type Probe = () => Promise<unknown>

export function versionAtLeast(version: string, floor: string): boolean {
  const num = (v: string) =>
    v
      .split('-')[0]
      ?.split('.')
      .map((x) => Number.parseInt(x, 10)) ?? []
  const a = num(version)
  const b = num(floor)
  if (a.length < 3 || a.some((n) => !Number.isFinite(n))) return false
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** True when `probe` returned, or failed with something other than "that is not a function / not there". */
export async function methodExists(probe: Probe | undefined): Promise<boolean> {
  if (!probe) return false
  try {
    await probe()
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isMissing = e instanceof TypeError && /not a function|undefined|is not defined|cannot read/i.test(msg)
    return !isMissing
  }
}

export type CapabilityReport =
  | { ok: true; version: string; capabilities: Capability[]; missing: string[] }
  | { ok: false; reason: 'core_missing' | 'version_unknown' | 'version_too_old'; version?: string; missing?: string[] }

export type ReportInput = {
  /** One probe per CORE_PROBES entry; `session.version` must resolve `{ version }`. */
  core: Partial<Record<CoreName, Probe>>
  /** Probes for METHOD_CAPS entries; a method with no probe is not reported. */
  methods: Partial<Record<string, Probe>>
}

/** The whole check, run at session.start. `ok:false` means: connect to nothing, report nothing. */
export async function reportCapabilities(input: ReportInput): Promise<CapabilityReport> {
  const missingCore: string[] = []
  let version: string | undefined
  for (const name of CORE_PROBES) {
    const probe = input.core[name]
    try {
      if (!probe) throw new TypeError('no probe')
      const r = await probe()
      if (name === 'session.version') {
        const v = (r as { version?: unknown } | undefined)?.version
        version = typeof v === 'string' ? v : undefined
      }
    } catch {
      missingCore.push(name)
    }
  }
  if (missingCore.length > 0) return { ok: false, reason: 'core_missing', missing: missingCore }
  if (!version) return { ok: false, reason: 'version_unknown' }
  if (!versionAtLeast(version, MIN_VERSION)) return { ok: false, reason: 'version_too_old', version }
  const caps = new Set<Capability>()
  const missing: string[] = []
  for (const [method, gives] of METHOD_CAPS) {
    if (await methodExists(input.methods[method])) {
      for (const c of gives) if (IMPLEMENTED.has(c)) caps.add(c)
    } else {
      missing.push(method)
    }
  }
  return { ok: true, version, capabilities: [...caps], missing }
}
