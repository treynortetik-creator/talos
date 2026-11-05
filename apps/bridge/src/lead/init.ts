// `talos-app lead init`: makes a lead's folder (brief, board, decisions, fence and sandbox settings, hooks) and points the
// thread at it. Files the owner may have edited are written once and never overwritten; the settings
// (.claude/settings.json), the hooks and the marker are rewritten on every run, keeping the owner's additions, so they
// cannot rot. Everything is checked before
// the first byte is written, and no write ever follows a symbolic link: a link where a file or folder should be is refused.
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { checkWorkerCwd } from '@talos-app/protocol'
import { real } from '../guards/rules.ts'
import { defaultLeadRoots, readOwnerMcp } from './fence.ts'
import {
  LEAD_BOARD_MAX,
  LEAD_BRIEF_MAX,
  LEAD_DENIED_TOOLS,
  type LeadSettings,
  leadSettings,
  mergeLeadSettings,
} from './settings.ts'

export const LEAD_MARKER = '.talos-lead'
export const DEFAULT_TEMPLATES = join(import.meta.dir, '..', '..', '..', '..', 'kit', 'templates', 'lead')

export class LeadError extends Error {}

export type LeadInitOpts = {
  threadId: string
  threadName: string
  folder: string
  agentDir: string
  talosHome: string
  home: string
  /** Claude Code's config folder (CLAUDE_CONFIG_DIR, else `<home>/.claude`); the caller reads the variable once. */
  claudeDir: string
  /** The folders on the owner's PATH and $TMPDIR, read once by the CLI (see `leadSettings`). */
  pathDirs?: readonly string[]
  tmpDirs?: readonly string[]
  protect?: readonly string[]
  disableMcp?: readonly string[]
  templates?: string
}

/** Characters Claude Code reads as a glob in a permission rule. */
const GLOB_CHARS = /[*?[\]{}]/
const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent.replace(/\/+$/, '')}/`)
const lstat = (p: string) => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function readTemplate(dir: string, name: string, vars: Record<string, string>): string {
  const t = readFileSync(join(dir, name), 'utf8')
  return t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '')
}

/** A real agent folder has a `.talos-version` or a `CLAUDE.md`. A typo is refused, not fenced. */
export function checkAgentDir(agentDir: string): string {
  if (!isAbsolute(agentDir)) throw new LeadError('--agent-dir must be an absolute path')
  const agent = real(agentDir)
  const st = lstat(agent)
  if (!st?.isDirectory() || !(existsSync(join(agent, '.talos-version')) || existsSync(join(agent, 'CLAUDE.md'))))
    throw new LeadError(
      `${agentDir} is not an agent folder (no .talos-version or CLAUDE.md in it); check --agent-dir or TALOS_AGENT_DIR`,
    )
  return agent
}

type Marker = { thread?: string; protect?: string[]; agent_dir?: string; claude_dir?: string }
function markerOf(folder: string): Marker | null {
  try {
    return JSON.parse(readFileSync(join(folder, LEAD_MARKER), 'utf8')) as Marker
  } catch {
    return null
  }
}

/** Everything refused before a byte is written. Returns the resolved folder and the roots to protect. */
export function checkLeadTarget(
  o: Pick<LeadInitOpts, 'threadId' | 'folder' | 'agentDir' | 'talosHome' | 'home' | 'claudeDir' | 'protect'>,
): { folder: string; agent: string; roots: string[] } {
  if (!isAbsolute(o.folder)) throw new LeadError('--folder must be an absolute path')
  const agent = checkAgentDir(o.agentDir)
  const leaf = lstat(o.folder)
  if (leaf?.isSymbolicLink()) throw new LeadError(`${o.folder} is a symbolic link; lead init never follows one`)
  const folder = real(o.folder)
  if (inside(folder, agent) || inside(agent, folder))
    throw new LeadError(
      `the lead's folder must be outside the main agent folder (${agent}), so it does not inherit its rules`,
    )
  // the same rules as any thread folder, on the resolved path, before the folder exists
  const home = real(o.home)
  const why = checkWorkerCwd(folder, {
    home,
    talosHome: real(o.talosHome),
    claudeDir: real(o.claudeDir),
  })
  if (why) throw new LeadError(`the folder ${o.folder} cannot be a lead folder: ${why}`)
  const prior = existsSync(join(folder, LEAD_MARKER)) ? markerOf(folder) : null
  const roots = [
    ...new Set([
      ...defaultLeadRoots({
        agentDir: agent,
        talosHome: o.talosHome,
        home: o.home,
        claudeDir: o.claudeDir,
        protect: o.protect,
      }),
      ...(prior?.protect ?? []),
    ]),
  ]
  // Claude Code reads `*?[]{}` in a rule as a pattern, so a root with one would not name that folder
  for (const r of [...roots, o.claudeDir, folder])
    if (GLOB_CHARS.test(r))
      throw new LeadError(
        `${r} has a glob character (* ? [ ] { }) in it; Claude Code would read the rule as a pattern. Pick a path without one`,
      )
  for (const r of roots) {
    const rr = real(r)
    if (inside(folder, rr) || inside(rr, folder))
      throw new LeadError(`the lead's folder must be outside the protected folder ${r}`)
  }
  if (existsSync(folder)) {
    if (!statSync(folder).isDirectory()) throw new LeadError(`${folder} is not a folder`)
    if (existsSync(join(folder, LEAD_MARKER))) {
      const who = String(prior?.thread ?? '')
      if (who !== o.threadId)
        throw new LeadError(`${folder} belongs to another thread (${who || 'unknown'}); pick another folder`)
    } else if (readdirSync(folder).length > 0) {
      throw new LeadError(`${folder} is not empty and was not made by lead init; use an empty or new folder`)
    }
  }
  return { folder, agent, roots }
}

/** Refuses a link (or anything not the expected kind) at `path`. A path that does not exist yet is fine. */
function assertPlain(path: string, kind: 'file' | 'dir') {
  const st = lstat(path)
  if (!st) return
  if (st.isSymbolicLink()) throw new LeadError(`${path} is a symbolic link; lead init never follows one`)
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile())
    throw new LeadError(`${path} is not a plain ${kind === 'dir' ? 'folder' : 'file'}`)
}

/** Writes a new file with O_EXCL and O_NOFOLLOW (mode kept even under a strict umask). */
function createFile(path: string, data: string | Uint8Array, mode: number) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    if (!fstatSync(fd).isFile()) throw new LeadError(`${path} is not a plain file`)
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data)
    fchmodSync(fd, mode)
  } finally {
    closeSync(fd)
  }
}

/** Replaces a plain file (or makes it): a new file beside it, then a rename. The link check runs again just before. */
function replaceFile(path: string, data: string | Uint8Array, mode: number) {
  assertPlain(path, 'file')
  const tmp = join(dirname(path), `.${basename(path)}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    createFile(tmp, data, mode)
    assertPlain(path, 'file')
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw e
  }
}

export type LeadInitResult = { folder: string; created: string[]; kept: string[]; settings: LeadSettings }

export function initLeadFolder(o: LeadInitOpts): LeadInitResult {
  const { folder, agent, roots } = checkLeadTarget(o)
  const tpl = o.templates ?? DEFAULT_TEMPLATES
  const vars = { thread_id: o.threadId, thread_name: o.threadName }
  const brief = readTemplate(tpl, 'CLAUDE.md.tmpl', vars)
  const board = readTemplate(tpl, 'BOARD.md.tmpl', vars)
  if (Buffer.byteLength(brief) > LEAD_BRIEF_MAX)
    throw new LeadError(`the CLAUDE.md template is over ${LEAD_BRIEF_MAX} bytes`)
  if (Buffer.byteLength(board) > LEAD_BOARD_MAX)
    throw new LeadError(`the BOARD.md template is over ${LEAD_BOARD_MAX} bytes`)
  const decisions = readTemplate(tpl, 'decisions.md.tmpl', vars)
  const kitHooks = [
    ['board-stop.sh', readFileSync(join(tpl, 'board-stop.sh'))],
    ['turn-start.sh', readFileSync(join(tpl, 'turn-start.sh'))],
  ] as const

  const fresh = leadSettings({
    agentDir: agent,
    talosHome: o.talosHome,
    home: o.home,
    claudeDir: o.claudeDir,
    folder,
    ...(o.pathDirs ? { pathDirs: o.pathDirs } : {}),
    ...(o.tmpDirs ? { tmpDirs: o.tmpDirs } : {}),
    protect: roots.filter(
      (r) =>
        !defaultLeadRoots({ agentDir: agent, talosHome: o.talosHome, home: o.home, claudeDir: o.claudeDir }).includes(
          r,
        ),
    ),
    ...(o.disableMcp ? { disableMcp: o.disableMcp } : {}),
    ownerMcp: readOwnerMcp(o.home, agent, o.claudeDir),
  })

  // 1. look at everything first: no link anywhere on the way, nothing of the wrong kind
  const claude = join(folder, '.claude')
  const hooks = join(claude, 'hooks')
  assertPlain(claude, 'dir')
  assertPlain(hooks, 'dir')
  const once = [
    ['CLAUDE.md', brief],
    ['BOARD.md', board],
    ['decisions.md', decisions],
  ] as const
  for (const [rel] of once) assertPlain(join(folder, rel), 'file')
  const sp = join(claude, 'settings.json')
  const mp = join(folder, LEAD_MARKER)
  // lead-guard.sh is the old guard (a re-run removes it); checked like the rest so a link there is refused
  const oldGuard = join(hooks, 'lead-guard.sh')
  for (const p of [sp, mp, oldGuard, ...kitHooks.map(([n]) => join(hooks, n))]) assertPlain(p, 'file')
  let old: unknown
  if (lstat(sp)) {
    try {
      old = JSON.parse(readFileSync(sp, 'utf8'))
    } catch {}
  }

  // 2. write
  const created: string[] = []
  const kept: string[] = []
  mkdirSync(folder, { recursive: true })
  assertPlain(folder, 'dir')
  for (const d of [claude, hooks]) {
    if (!lstat(d)) mkdirSync(d)
    assertPlain(d, 'dir')
  }
  for (const [rel, body] of once) {
    if (lstat(join(folder, rel))) kept.push(rel)
    else {
      createFile(join(folder, rel), body, 0o644)
      created.push(rel)
    }
  }
  // hooks are the kit's, not the owner's: always refreshed
  for (const [n, body] of kitHooks) replaceFile(join(hooks, n), body, 0o755)
  replaceFile(sp, `${JSON.stringify(mergeLeadSettings(old, fresh), null, 2)}\n`, 0o644)
  // the old text-parsing guard is gone (the OS sandbox does that job now); only after the new settings are in place
  if (lstat(oldGuard)) {
    assertPlain(oldGuard, 'file')
    unlinkSync(oldGuard)
  }
  replaceFile(
    mp,
    `${JSON.stringify({
      thread: o.threadId,
      agent_dir: agent,
      home: o.home,
      talos_home: o.talosHome,
      claude_dir: o.claudeDir,
      protect: roots,
    })}\n`,
    0o644,
  )
  return { folder, created, kept, settings: fresh }
}

const objOf = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null)
function readJson(file: string): Record<string, unknown> | null {
  try {
    return objOf(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

/**
 * Problems with an existing lead folder: sizes, the marker, and that the sandbox and the fence are the safe ones. It is the
 * owner's check; nothing runs it at session start. The start-time guarantee is claude's own `failIfUnavailable`: claude
 * exits when the sandbox cannot run. `claudeDir` is the fallback (the env, else `~/.claude`) when the marker has no
 * `claude_dir`.
 */
export function checkLeadFolder(
  folder: string,
  agentDir: string | undefined,
  talosHome: string,
  home: string,
  claudeDir: string,
): string[] {
  const out: string[] = []
  const size = (f: string, max: number) => {
    try {
      const n = statSync(join(folder, f)).size
      if (n > max) out.push(`${f} is ${n} bytes, over the ${max} limit`)
    } catch {
      out.push(`${f} is missing`)
    }
  }
  const marker = existsSync(join(folder, LEAD_MARKER)) ? markerOf(folder) : null
  if (!existsSync(join(folder, LEAD_MARKER))) out.push(`${folder} was not made by lead init (no ${LEAD_MARKER})`)
  // the Claude folder the lead was made for: the marker's, else the one the caller found
  const cdir = typeof marker?.claude_dir === 'string' && isAbsolute(marker.claude_dir) ? marker.claude_dir : claudeDir
  size('CLAUDE.md', LEAD_BRIEF_MAX)
  size('BOARD.md', LEAD_BOARD_MAX)
  if (!existsSync(join(folder, 'decisions.md'))) out.push('decisions.md is missing')
  for (const h of ['board-stop.sh', 'turn-start.sh'])
    if (!existsSync(join(folder, '.claude', 'hooks', h))) out.push(`.claude/hooks/${h} is missing: re-run lead init`)
  const settings = readJson(join(folder, '.claude', 'settings.json'))
  if (!settings) {
    out.push('.claude/settings.json is missing or not JSON: the privacy fence and sandbox are not in place')
    return out
  }
  const sandbox = objOf(settings.sandbox)
  if (sandbox.enabled !== true) out.push('sandbox.enabled is not true: the OS sandbox is off; re-run lead init')
  if (sandbox.failIfUnavailable !== true)
    out.push('sandbox.failIfUnavailable is not true: claude would start without the sandbox; re-run lead init')
  if (sandbox.allowUnsandboxedCommands !== false)
    out.push('sandbox.allowUnsandboxedCommands is not false: a command could leave the sandbox; re-run lead init')
  if (nonEmpty(sandbox.excludedCommands))
    out.push('sandbox.excludedCommands is not empty: those commands run unsandboxed')
  const fs = objOf(sandbox.filesystem)
  if (nonEmpty(fs.allowRead)) out.push('sandbox.filesystem.allowRead is not empty: it can re-open a protected root')
  if (nonEmpty(fs.allowWrite)) out.push('sandbox.filesystem.allowWrite is not empty: it can re-open a protected root')
  if (fs.disabled) out.push('sandbox.filesystem.disabled is set: the sandbox does not hold file access')
  if (settings.disableClaudeAiConnectors !== true)
    out.push('claude.ai connectors are not switched off: re-run lead init')
  const have = new Set(
    Array.isArray(objOf(settings.permissions).deny) ? (objOf(settings.permissions).deny as unknown[]) : [],
  )
  for (const t of LEAD_DENIED_TOOLS) if (!have.has(t)) out.push(`the ${t} tool is not denied: re-run lead init`)
  const agent = agentDir ?? marker?.agent_dir
  if (agent && home) {
    const want = leadSettings({
      agentDir: agent,
      talosHome,
      home,
      claudeDir: cdir,
      folder: real(folder),
      protect: marker?.protect ?? [],
    }).permissions.deny.filter((d) => !(LEAD_DENIED_TOOLS as readonly string[]).includes(d))
    const lost = want.filter((d) => !have.has(d))
    if (lost.length)
      out.push(`the privacy fence is missing ${lost.length} deny rule(s), e.g. ${lost[0]}; re-run lead init`)
  } else if (have.size === 0) out.push('the privacy fence is empty: no deny rules')

  // settings the lead folder or the owner's user file add on top can open the sandbox again
  const local = readJson(join(folder, '.claude', 'settings.local.json'))
  if (local) {
    if ('sandbox' in local) out.push('.claude/settings.local.json sets sandbox keys: remove them')
    if (nonEmpty(objOf(local.permissions).allow))
      out.push('.claude/settings.local.json sets permissions.allow: remove it')
  }
  const user = readJson(join(cdir, 'settings.json'))
  if (user) {
    // sandbox.enabled: false there is not reported: the lead's own `true` wins
    const us = objOf(user.sandbox)
    const ufs = objOf(us.filesystem)
    const weak = `in ${join(cdir, 'settings.json')} weakens the sandbox of every lead`
    if (nonEmpty(us.excludedCommands)) out.push(`sandbox.excludedCommands ${weak}`)
    if (nonEmpty(ufs.allowRead)) out.push(`sandbox.filesystem.allowRead ${weak}`)
    if (nonEmpty(ufs.allowWrite)) out.push(`sandbox.filesystem.allowWrite ${weak}`)
    if (ufs.disabled) out.push(`sandbox.filesystem.disabled ${weak}`)
  }
  return out
}
