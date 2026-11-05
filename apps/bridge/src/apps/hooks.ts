// The three hook events of one binary (M5.2): `talos-app hook pre-tool-use|post-tool-use|post-tool-use-failure`.
// pre-tool-use is the gate and FAILS CLOSED: any internal error answers `deny`. The post hooks fail open (exit 0).
// Claude Code runs these as `bun run --cwd <dir>/apps/bridge --silent cli hook <event>`; the event is the argument
// after `hook` (gate G6).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CaptureId, jcs } from '@talos-app/protocol'
import { z } from 'zod'
import { type NormaliseCtx, type Normalised, normaliseToolResponse, pruneCaptures, writeCapture } from './captures.ts'
import { type CatalogServerT, matchTool, readCatalog } from './catalog.ts'
import type { AppPaths } from './paths.ts'
import { claim, effectiveState, listPending, readClaimedByToolUse, sameArguments } from './pending.ts'

export const HOOK_EVENTS = ['pre-tool-use', 'post-tool-use', 'post-tool-use-failure'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** `hook <event>` after the script name. Returns undefined for anything else. */
export function parseHookArgv(argv: string[]): HookEvent | undefined {
  const i = argv.indexOf('hook')
  if (i < 0) return undefined
  const e = argv[i + 1]
  return (HOOK_EVENTS as readonly string[]).includes(e as string) ? (e as HookEvent) : undefined
}

export const HOOK_STDIN_MAX = 16 * 1024 * 1024
export const DENY_GATE_ERROR = 'Talos app gate error; tool blocked. Tell the owner.'

const HookInput = z.object({
  tool_name: z.string().min(1).max(300),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  transcript_path: z.string().optional(),
  session_id: z.string().optional(),
  mcp_server: z.object({ name: z.string(), source: z.string().optional() }).optional(),
})
type HookInputT = z.infer<typeof HookInput>

export type HookOutput = Record<string, unknown> | undefined

export type HookDeps = {
  paths: AppPaths
  now: () => number
  /** `TALOS_APP_BRIDGE` from the hook's environment. */
  live: boolean
}

const deny = (reason: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

type Resolved = { server: CatalogServerT; tool: CatalogServerT['tools'][number] }

/**
 * The catalogued server and tool a hook call is about. `undefined`: positively not one of ours (pass through).
 * `'ambiguous'`: more than one catalogued server fits (a missing or partial `mcp_server`, or two servers whose names map to
 * one prefix): the gate must refuse, because uncertain state never allows an action. Whatever `mcp_server` does carry
 * (name, source) narrows the candidates; the tool prefix does the rest.
 */
function resolve(servers: CatalogServerT[], input: HookInputT): Resolved | 'ambiguous' | undefined {
  const hits: Resolved[] = []
  for (const s of servers) {
    if (!s.resources.some((r) => r.state === 'approved' || r.state === 'needs_reapproval')) continue
    if (!input.tool_name.startsWith(s.tool_prefix)) continue
    if (input.mcp_server && input.mcp_server.name !== s.server) continue
    if (input.mcp_server?.source !== undefined && input.mcp_server.source !== s.source) continue
    const tool = matchTool(s, input.tool_name)
    if (tool) hits.push({ server: s, tool })
  }
  if (hits.length === 0) return undefined
  return hits.length === 1 ? (hits[0] as Resolved) : 'ambiguous'
}

function parseInput(stdin: string): HookInputT | undefined {
  if (stdin.length > HOOK_STDIN_MAX) return undefined
  try {
    const r = HookInput.safeParse(JSON.parse(stdin))
    return r.success ? r.data : undefined
  } catch {
    return undefined
  }
}

// ---- pre-tool-use --------------------------------------------------------------------------------------------------

function preToolUse(stdin: string, d: HookDeps): HookOutput {
  const input = parseInput(stdin)
  if (!input) return deny(DENY_GATE_ERROR)
  const cat = readCatalog(d.paths)
  if (!cat.ok) return deny(DENY_GATE_ERROR)
  if (!cat.catalog) return undefined
  const hit = resolve(cat.catalog.servers, input)
  if (hit === 'ambiguous') return deny(DENY_GATE_ERROR)
  if (!hit) return undefined
  const toolUseId = input.tool_use_id
  if (toolUseId === undefined || !CaptureId.safeParse(toolUseId).success) return deny(DENY_GATE_ERROR)
  const now = d.now()
  const listing = listPending(d.paths, now)
  // a pending file we cannot read could be the request that must be gated: fail closed while it is recent
  if (listing.corrupt.some((c) => c.ageMs < 10 * 60_000)) return deny(DENY_GATE_ERROR)
  const agentInput = input.tool_input ?? {}
  const mine = listing.requests
    .filter((r) => r.server === hit.server.server && r.server_source === hit.server.source && r.tool === hit.tool.name)
    .filter((r) => {
      // matches only an empty input or the approved arguments (N3): the owner's own calls pass through
      const empty = typeof agentInput === 'object' && agentInput !== null && Object.keys(agentInput).length === 0
      return empty || sameArguments(agentInput, r.arguments)
    })
  const live = mine.map((r) => ({ r, s: effectiveState(r, now).state })).filter((x) => x.s !== 'gone')
  const ready = live
    .filter((x) => x.s === 'authorised')
    .sort((a, b) => Date.parse(a.r.created_at) - Date.parse(b.r.created_at))
  for (const x of ready) {
    if (claim(d.paths, x.r, toolUseId, new Date(now).toISOString())) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: x.r.arguments,
        },
      }
    }
  }
  const waiting = live.find((x) => x.s === 'awaiting_card')
  if (waiting)
    return deny(
      `Waiting for the owner to approve app request ${waiting.r.request_id}; don't call ${hit.tool.name} with these arguments until a card_action arrives.`,
    )
  const expired = live.find((x) => x.s === 'expired')
  if (expired) return deny(`App request ${expired.r.request_id} expired; nothing was approved. Ask the owner.`)
  return undefined
}

// ---- post hooks ----------------------------------------------------------------------------------------------------

function post(event: 'post-tool-use' | 'post-tool-use-failure', stdin: string, d: HookDeps): HookOutput {
  const input = parseInput(stdin)
  if (!input) return undefined
  const cat = readCatalog(d.paths)
  if (!cat.ok || !cat.catalog) return undefined
  const hit = resolve(cat.catalog.servers, input)
  if (!hit || hit === 'ambiguous') return undefined
  const id = input.tool_use_id
  if (id === undefined || !CaptureId.safeParse(id).success) return undefined
  const now = d.now()
  const eventName = event === 'post-tool-use' ? 'PostToolUse' : 'PostToolUseFailure'
  const ctx: NormaliseCtx = {
    server: hit.server.server,
    tool: hit.tool.name,
    transcript_path: input.transcript_path,
    session_id: input.session_id,
    nowMs: now,
  }
  const claimed = readClaimedByToolUse(d.paths, id)
  const isUiTool = hit.tool.resource_uri !== undefined
  if (!claimed && !isUiTool) return undefined
  // a failed call nobody claimed has nothing to show
  if (!claimed && event === 'post-tool-use-failure') return undefined
  const ok = event === 'post-tool-use'
  // PostToolUseFailure carries `error` and no `tool_response` (Claude Code's hook schema): there is no result to hand over, and
  // the error text is the server's, so it never goes to the view. The app is told tool_failed.
  const norm: Normalised | { failed: true } = ok ? normaliseToolResponse(input.tool_response, ctx) : { failed: true }
  const toolInput =
    typeof input.tool_input === 'object' && input.tool_input !== null && !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : {}
  writeCapture(d.paths, {
    capture_id: id,
    server: hit.server.server,
    source: hit.server.source,
    tool: hit.tool.name,
    tool_input: claimed ? claimed.arguments : toolInput,
    ...('result' in norm ? { result: norm.result } : {}),
    ok,
    ...('too_large' in norm ? { too_large: true } : {}),
    at: new Date(now).toISOString(),
  })
  pruneCaptures(d.paths, now, new Set([id]))
  if (claimed) {
    const owner = cat.catalog.servers
      .find((s) => s === hit.server)
      ?.resources.find((r) => r.uri === hit.tool.resource_uri)
    const label = owner?.owner.label ?? hit.server.server
    const bytes = 'result' in norm ? new TextEncoder().encode(jcs(norm.result)).length : 0
    // PostToolUseFailure accepts only `additionalContext`: a failed call's error text reaches the agent as Claude Code shows it
    if (!ok)
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: `Talos: this call was made for app "${label}" and failed. The app was told. Nothing else to do.`,
        },
      }
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        updatedToolOutput: `Result handed to app "${label}" (${bytes} bytes, capture ${id}). Nothing else to do. If you made this call for the owner, make it again.`,
      },
    }
  }
  const label = hit.server.resources.find((r) => r.uri === hit.tool.resource_uri)?.owner.label ?? hit.server.server
  if (!ok) return undefined
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `Talos: this result has an app view ("${label}"). To show it in the thread, call app_show with capture_id "${id}".`,
    },
  }
}

/**
 * One hook call. `TALOS_APP_BRIDGE` other than 1: no output at all (scheduled `claude -p` jobs are untouched). The gate
 * turns every error into a deny; the post hooks turn it into silence.
 */
export function runHook(event: HookEvent, stdin: string, d: HookDeps): HookOutput {
  if (!d.live) return undefined
  if (event === 'pre-tool-use') {
    try {
      return preToolUse(stdin, d)
    } catch {
      return deny(DENY_GATE_ERROR)
    }
  }
  try {
    return post(event, stdin, d)
  } catch {
    return undefined
  }
}

// ---- installing the hooks into <agent-dir>/.claude/settings.local.json (M5.2) ---------------------------------------

/** Our entries are the ones whose command contains this; nothing else in the file is touched. */
export const HOOK_MARKER = '--silent cli hook'
export const KEYCHAIN_DENY = ['Bash(security find-generic-password:*)', 'Bash(security dump-keychain:*)'] as const

type Json = Record<string, unknown>

const shq = (s: string) => (/^[A-Za-z0-9_/.@:+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

const hookCommand = (bridgeDir: string, event: HookEvent) => `bun run --cwd ${shq(bridgeDir)} ${HOOK_MARKER} ${event}`

const isOurs = (h: unknown): boolean =>
  typeof h === 'object' &&
  h !== null &&
  typeof (h as Json).command === 'string' &&
  ((h as Json).command as string).includes(HOOK_MARKER)

/** Pure merge: foreign hooks and settings are kept, our entries are replaced (so running it twice changes nothing). */
export function mergeHookSettings(
  existing: Json,
  opts: { bridgeDir: string; prefixes: string[]; keychainDeny: boolean },
  matcherOf: (prefix: string) => string,
): Json {
  const out: Json = structuredClone(existing)
  const hooks: Record<string, unknown[]> = {}
  const cur = (out.hooks !== null && typeof out.hooks === 'object' ? out.hooks : {}) as Record<string, unknown>
  for (const [ev, groups] of Object.entries(cur)) {
    if (!Array.isArray(groups)) {
      hooks[ev] = groups as unknown as unknown[]
      continue
    }
    const kept: unknown[] = []
    for (const g of groups) {
      if (g !== null && typeof g === 'object' && Array.isArray((g as Json).hooks)) {
        const rest = ((g as Json).hooks as unknown[]).filter((h) => !isOurs(h))
        if (rest.length === 0) continue
        kept.push({ ...(g as Json), hooks: rest })
      } else kept.push(g)
    }
    if (kept.length) hooks[ev] = kept
  }
  const add = (ev: string, event: HookEvent, timeout: number, block: boolean) => {
    for (const prefix of opts.prefixes) {
      const list = hooks[ev] ?? []
      hooks[ev] = list
      list.push({
        matcher: matcherOf(prefix),
        hooks: [
          {
            type: 'command',
            timeout,
            ...(block ? { onFailure: 'block' } : {}),
            command: hookCommand(opts.bridgeDir, event),
          },
        ],
      })
    }
  }
  add('PreToolUse', 'pre-tool-use', 10, true)
  add('PostToolUse', 'post-tool-use', 10, false)
  add('PostToolUseFailure', 'post-tool-use-failure', 5, false)
  if (Object.keys(hooks).length) out.hooks = hooks
  else delete out.hooks
  if (opts.keychainDeny) {
    const perms = (out.permissions !== null && typeof out.permissions === 'object' ? out.permissions : {}) as Json
    const deny = Array.isArray(perms.deny) ? [...(perms.deny as unknown[])] : []
    for (const e of KEYCHAIN_DENY) if (!deny.includes(e)) deny.push(e)
    out.permissions = { ...perms, deny }
  }
  return out
}

/**
 * Writes the merge to `settingsPath`. Only a file named settings.local.json is ever written (local scope: it holds a
 * machine path; never user scope). Returns whether the file changed.
 */
export function installHookSettings(
  settingsPath: string,
  opts: { bridgeDir: string; prefixes: string[]; keychainDeny: boolean },
  matcherOf: (prefix: string) => string,
): { changed: boolean } {
  if (basename(settingsPath) !== 'settings.local.json')
    throw new Error('hooks are installed into settings.local.json only')
  let text = ''
  let existing: Json = {}
  try {
    text = readFileSync(settingsPath, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    existing = parsed as Json
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (text !== '') throw new Error(`${settingsPath} is not valid JSON; fix it and run the scan again`)
    }
  }
  const merged = mergeHookSettings(existing, opts, matcherOf)
  if (text !== '' && jcs(merged) === jcs(existing)) return { changed: false }
  if (text === '' && Object.keys(merged).length === 0) return { changed: false }
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmp = join(dirname(settingsPath), `.settings-${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, settingsPath)
  return { changed: true }
}
