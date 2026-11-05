// Doctor rows about Claude Code itself: the installed mods (plugins), the Talos mod's version, the shipped kit files
// and `claude doctor`. Claude is run with no terminal and a hard time limit; a missing or stuck claude is a warning.
import { createHash } from 'node:crypto'
import { constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Check } from './doctor-checks.ts'

type Add = (level: Check['level'], name: string, detail: string) => void

const CLAUDE_TIMEOUT_MS = 5000
const TALOS_MOD = 'talos-app-mod'
const MOD_MANIFEST = resolve(dirname(import.meta.path), '../../../plugins/talos-app-mod/.claude-plugin/plugin.json')

type RunResult = { ok: true; out: string } | { ok: false; why: string }

type RunOpts = { cwd: string; claudeDir: string | undefined }

/** Kills claude and everything it started (it runs in its own process group). */
function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/** Runs `claude <args>` in the agent folder with no stdin and a time limit. Never throws and never waits past the limit. */
async function runClaude(args: string[], o: RunOpts): Promise<RunResult> {
  const bin = Bun.which('claude', { PATH: process.env.PATH ?? '' })
  if (!bin) return { ok: false, why: 'claude is not on PATH' }
  try {
    const env = { ...process.env, ...(o.claudeDir ? { CLAUDE_CONFIG_DIR: o.claudeDir } : {}) }
    const proc = Bun.spawn([bin, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      killSignal: 'SIGKILL',
      cwd: o.cwd,
      env,
      detached: true,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), CLAUDE_TIMEOUT_MS)
    })
    const done = (async () => {
      const out = await new Response(proc.stdout).text()
      return { out, code: await proc.exited }
    })()
    const res = await Promise.race([done, timedOut])
    clearTimeout(timer)
    if (res === 'timeout') {
      killGroup(proc.pid)
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 1000))])
      return { ok: false, why: `no answer in ${CLAUDE_TIMEOUT_MS / 1000} s` }
    }
    // Anything claude left running in its group after it exits goes too.
    killGroup(proc.pid)
    return res.code === 0 ? { ok: true, out: res.out } : { ok: false, why: `exited ${res.code}` }
  } catch (e) {
    return { ok: false, why: (e as Error).message }
  }
}

type Mod = { name: string; version: string; scope: string; enabled: boolean | undefined; error?: string }

const bare = (id: string) => id.split('@')[0] ?? id

const LIST_KEYS = ['plugins', 'pluginsV2', 'installed']
const errorText = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined
  if (Array.isArray(v)) {
    const t = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')
    return t || undefined
  }
  if (v && typeof v === 'object') return Object.keys(v).length ? JSON.stringify(v) : undefined
  return undefined
}

/** The `--json` listing: an array, or an object holding one (`plugins`, `pluginsV2`, `installed`). Anything else is undefined.
 *  `entries` is how many items the list had, so a list of items we could not read is not mistaken for an empty one. */
function parseModsJson(out: string): { mods: Mod[]; entries: number } | undefined {
  let v: unknown
  try {
    v = JSON.parse(out)
  } catch {
    return undefined
  }
  let list: unknown
  if (Array.isArray(v)) list = v
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    list = LIST_KEYS.map((k) => o[k]).find(Array.isArray)
  }
  if (!Array.isArray(list)) return undefined
  const mods: Mod[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const id = [r.id, r.name, r.pluginId].find((x): x is string => typeof x === 'string' && x.length > 0)
    if (!id) continue
    const error = errorText(r.errors)
    mods.push({
      name: bare(id),
      version: typeof r.version === 'string' && r.version ? r.version : 'unknown',
      scope: typeof r.scope === 'string' ? r.scope : 'unknown',
      enabled: typeof r.enabled === 'boolean' ? r.enabled : undefined,
      ...(error ? { error } : {}),
    })
  }
  return { mods, entries: list.length }
}

/** The plain listing: a name line (`❯ name@market`), then `Version:`, `Scope:` and `Status:` lines. */
function parseModsText(out: string): Mod[] {
  const mods: Mod[] = []
  for (const raw of out.split('\n')) {
    const l = raw.trim()
    const field = /^(Version|Scope|Status):\s*(.*)$/i.exec(l)
    const cur = mods[mods.length - 1]
    if (field && cur) {
      const key = (field[1] ?? '').toLowerCase()
      const val = field[2] ?? ''
      if (key === 'version') cur.version = val
      else if (key === 'scope') cur.scope = val
      else if (/failed to load/i.test(val)) cur.error = val.replace(/^[^\w]+/, '')
      else cur.enabled = /enabled/i.test(val) && !/disabled/i.test(val)
      continue
    }
    const name = /^[^\w@]*([\w.-]+@[\w.-]+)\s*$/.exec(l)
    if (name?.[1]) mods.push({ name: bare(name[1]), version: 'unknown', scope: 'unknown', enabled: undefined })
  }
  return mods
}

/** Numeric dotted compare: negative when a is older than b. Pre-release tags are ignored. */
function cmpVersion(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

const NOT_LISTED = 'could not list them. Run `claude plugin list` in Terminal'
const UNREADABLE = "couldn't read claude's plugin list. Run `claude plugin list` in Terminal to see it"
const NONE_TEXT = /\b(no|zero|none)\b.*\b(plugins?|mods?)\b|\bnone installed\b/i

type Listed = { mods: Mod[] } | { why: string } | { unreadable: true }

async function listMods(o: RunOpts): Promise<Listed> {
  const asJson = await runClaude(['plugin', 'list', '--json'], o)
  if (asJson.ok) {
    const parsed = parseModsJson(asJson.out)
    if (parsed) return parsed.mods.length === 0 && parsed.entries > 0 ? { unreadable: true } : { mods: parsed.mods }
  } else if (asJson.why === 'claude is not on PATH' || asJson.why.startsWith('no answer')) return { why: asJson.why }
  const asText = await runClaude(['plugin', 'list'], o)
  if (!asText.ok) return { why: asText.why }
  const mods = parseModsText(asText.out)
  if (mods.length === 0 && asText.out.trim() && !NONE_TEXT.test(asText.out)) return { unreadable: true }
  return { mods }
}

function modRows(listed: Listed, add: Add) {
  if ('why' in listed) return add('warn', 'claude mods', `${NOT_LISTED} (${listed.why})`)
  if ('unreadable' in listed) return add('warn', 'claude mods', UNREADABLE)
  if (listed.mods.length === 0) add('ok', 'claude mods', 'none installed')
  for (const m of listed.mods) {
    const where = `${m.version === 'unknown' ? 'version unknown' : m.version}, ${m.scope} scope`
    if (m.error) add('warn', `mod ${m.name}`, `${where}, failed to load: ${m.error}`)
    else add('ok', `mod ${m.name}`, `${where}${m.enabled === undefined ? '' : m.enabled ? ', enabled' : ', disabled'}`)
  }
  const talos = listed.mods.find((m) => m.name === TALOS_MOD)
  if (!talos) return add('ok', 'talos mod', 'Talos mod not installed in Claude Code')
  let repo: string | undefined
  try {
    repo = (JSON.parse(readFileSync(MOD_MANIFEST, 'utf8')) as { version?: string }).version
  } catch {}
  if (!repo) return
  if (talos.version === 'unknown')
    add(
      'warn',
      'talos mod version',
      `installed version unknown; this checkout is ${repo}. Check it in Claude Code (/plugin)`,
    )
  else if (cmpVersion(talos.version, repo) < 0)
    add(
      'warn',
      'talos mod version',
      `installed ${talos.version} is older than this checkout's ${repo}. Update the mod in Claude Code (/plugin) so its hooks match the bridge`,
    )
  else add('ok', 'talos mod version', `installed ${talos.version}, this checkout ${repo}`)
}

const MAX_KIT_FILE = 5 * 1024 * 1024

/** Hash of a kit file, or why it was not read. Only a regular file whose real path is inside the agent folder is opened,
 *  and it is opened without blocking, so a FIFO or device in the manifest cannot hang the doctor. */
async function hashKitFile(root: string, rel: string): Promise<{ sha: string } | { missing: true } | { skip: string }> {
  if (isAbsolute(rel)) return { skip: 'absolute path' }
  const abs = resolve(root, rel)
  const inside = relative(root, abs)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return { skip: 'outside the agent folder' }
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(abs)
  } catch {
    return { missing: true }
  }
  if (!st.isFile()) return { skip: st.isSymbolicLink() ? 'symlink' : 'not a regular file' }
  try {
    const real = realpathSync(abs)
    if (real !== root && !real.startsWith(root + sep)) return { skip: 'outside the agent folder' }
  } catch {
    return { missing: true }
  }
  if (st.size > MAX_KIT_FILE) return { skip: 'over 5 MB' }
  let fh: Awaited<ReturnType<typeof open>> | undefined
  try {
    fh = await open(abs, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    const now = await fh.stat()
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return { skip: 'not a regular file' }
    if (now.size > MAX_KIT_FILE) return { skip: 'over 5 MB' }
    const buf = await fh.readFile()
    if (buf.length > MAX_KIT_FILE) return { skip: 'over 5 MB' }
    return { sha: createHash('sha256').update(buf).digest('hex') }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { missing: true } : { skip: (e as Error).message }
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** `$AGENT_DIR/.talos/manifest.json` is `{ files: { relpath: sha256 } }`; a file that differs or is gone is named. */
async function kitRow(agentDir: string, add: Add) {
  const file = join(agentDir, '.talos', 'manifest.json')
  if (!existsSync(file))
    return add('ok', 'kit files', 'no kit manifest yet (expected until the kit writes one; nothing to check)')
  let files: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { files?: unknown }
    if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files))
      throw new Error('no files map')
    files = parsed.files as Record<string, unknown>
  } catch (e) {
    return add('warn', 'kit files', `${file} cannot be read (${(e as Error).message}); the edited-file check is off`)
  }
  let root = resolve(agentDir)
  try {
    root = realpathSync(root)
  } catch {}
  const changed: string[] = []
  const skipped: string[] = []
  let unchanged = 0
  for (const [rel, want] of Object.entries(files)) {
    const r = await hashKitFile(root, rel)
    if ('skip' in r) skipped.push(`${rel} (${r.skip})`)
    else if ('missing' in r) changed.push(`${rel} (missing)`)
    else if (r.sha === want) unchanged++
    else changed.push(rel)
  }
  const checked = unchanged + changed.length
  const counts = `${checked} checked, ${unchanged} unchanged, ${changed.length} changed, ${skipped.length} skipped`
  const skippedText = skipped.length ? `. Skipped, not read: ${skipped.join(', ')}` : ''
  if (changed.length === 0 && skipped.length === 0) add('ok', 'kit files', counts)
  else if (changed.length === 0) add('warn', 'kit files', `${counts}${skippedText}`)
  else
    add(
      'warn',
      'kit files',
      `${counts}. Edited since install: ${changed.join(', ')}. An update will not overwrite your edits; keep them or restore the shipped copy${skippedText}`,
    )
}

/**
 * Adds the mod rows, the kit row and a pointer to `claude doctor`. `claude doctor` always exits 0 and its warnings have no
 * stable wording (2026-11-03 review: a pattern match read a real warning as "ran without problems"), so Talos does not
 * run or grade it. It only points the owner at it.
 */
export async function modDoctorChecks(agentDir: string, add: Add, claudeDir?: string): Promise<void> {
  const o: RunOpts = { cwd: agentDir, claudeDir }
  modRows(await listMods(o), add)
  await kitRow(agentDir, add)
  add('ok', 'claude doctor', "not run here: run `claude doctor` in Terminal for Claude Code's own checks")
}
