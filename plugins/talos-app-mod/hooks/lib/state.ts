// SessionState as the bridge's schema wants it (packages/protocol session.ts), built from the DOCUMENTED engine
// fields: `$.session.usage()` gives `context.{tokens,window,percent}`, `rateLimits[].{kind,percentUsed,resetsAt}` and
// `cost.usd` (mods reference, "$.session"). Anything the engine does not give is left out, never zeroed, and every
// number is clamped to what the schema accepts so one odd reading cannot make the bridge drop the whole state.
import type { Capability } from './capabilities.ts'
import type { ConfigRowLike, EngineLike, UsageLike } from './engine.ts'

export type ModFlags = {
  busy: boolean
  turnId?: string
  compacting: boolean
  stoppedAtMac: boolean
}

export type StateOut = {
  session_id: string
  source: 'mod'
  capabilities: Capability[]
  version?: string
  model?: { id: string }
  effort?: string
  busy: boolean
  turn_id?: string
  compacting: boolean
  stopped_at_mac: boolean
  context?: { tokens?: number; window?: number; percent?: number }
  cost_usd?: number
  rate_limits: Array<{ kind: string; percent?: number; resets_at?: string }>
  surfaces: string[]
  at: string
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const pct = (n: unknown): number | undefined => (finite(n) && n >= 0 ? Math.min(100, n) : undefined)
const nat = (n: unknown): number | undefined => (finite(n) && n >= 0 ? Math.round(n) : undefined)
const short = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined

/** An ISO 8601 timestamp the schema accepts, from the engine's `resetsAt`; undefined when it is not one. */
export function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40) return undefined
  if (ISO.test(v)) return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** Runs `f`, turning a sync throw or a rejection into undefined. */
export const attempt = <T>(f: () => Promise<T> | T): Promise<T | undefined> =>
  Promise.resolve()
    .then(f)
    .catch(() => undefined)

export function usageToState(u: UsageLike | undefined): Pick<StateOut, 'context' | 'cost_usd' | 'rate_limits'> {
  const c = u?.context
  const context = c
    ? Object.fromEntries(
        Object.entries({ tokens: nat(c.tokens), window: nat(c.window), percent: pct(c.percent) }).filter(
          ([, v]) => v !== undefined,
        ),
      )
    : {}
  const rate_limits = (Array.isArray(u?.rateLimits) ? u.rateLimits : [])
    .map((l) => ({
      kind: short(l?.kind, 24),
      percent: pct(l?.percentUsed),
      resets_at: isoOrUndefined(l?.resetsAt),
    }))
    .filter((l): l is { kind: string; percent: number | undefined; resets_at: string | undefined } => !!l.kind)
    .slice(0, 6)
    .map((l) => ({
      kind: l.kind,
      ...(l.percent !== undefined ? { percent: l.percent } : {}),
      ...(l.resets_at !== undefined ? { resets_at: l.resets_at } : {}),
    }))
  const usd = u?.cost?.usd
  return {
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(finite(usd) && usd >= 0 ? { cost_usd: usd } : {}),
    rate_limits,
  }
}

/** The `/config` rows for model and effort, when the engine lists them (SMOKE S4 records what it shows). */
export function configFacts(rows: readonly ConfigRowLike[] | undefined): {
  effort?: string
  modelOptions: string[]
  effortOptions: string[]
} {
  const list = Array.isArray(rows) ? rows : []
  const effortRow = list.find((r) => r?.key === 'effort' || r?.key === 'effortLevel')
  const modelRow = list.find((r) => r?.key === 'model')
  const effort = short(effortRow?.value, 16)
  return {
    ...(effort ? { effort } : {}),
    modelOptions: (modelRow?.options ?? []).filter((o: unknown): o is string => typeof o === 'string'),
    effortOptions: (effortRow?.options ?? []).filter((o: unknown): o is string => typeof o === 'string'),
  }
}

export async function buildState(
  $: EngineLike,
  flags: ModFlags,
  capabilities: readonly Capability[],
  version: string | undefined,
): Promise<StateOut | undefined> {
  const id = short(await attempt(() => $.session.id()), 64)
  if (!id) return undefined
  // A missing method throws before any promise exists, so each call is wrapped: one absent field loses itself, not the sync.
  const [model, usage, surfaces, rows] = await Promise.all([
    attempt(() => $.session.model()),
    attempt(() => $.session.usage()),
    attempt(() => $.session.surfaces()),
    attempt(() => $.config.list()),
  ])
  const modelId = short(model, 80)
  const { effort } = configFacts(rows)
  return {
    session_id: id,
    source: 'mod',
    capabilities: [...capabilities],
    ...(version ? { version: version.slice(0, 40) } : {}),
    ...(modelId ? { model: { id: modelId } } : {}),
    ...(effort ? { effort } : {}),
    busy: flags.busy,
    ...(flags.turnId ? { turn_id: flags.turnId.slice(0, 64) } : {}),
    compacting: flags.compacting,
    stopped_at_mac: flags.stoppedAtMac,
    ...usageToState(usage),
    surfaces: (Array.isArray(surfaces) ? surfaces : [])
      .filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 24)
      .slice(0, 8),
    at: new Date(await $.clock.now()).toISOString(),
  }
}
