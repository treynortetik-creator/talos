// A short history of the agent's Claude Code setup, and `talos-app restore-last-good`, the undo for a customization that
// broke the agent. After a healthy start the live bridge saves the agent folder's .mcp.json and .claude settings files as a
// new version under $TALOS_APP_HOME/last-good/<timestamp>/, but only when they differ from the newest saved version, and it
// keeps the newest 10. Each version records the agent folder it came from. A config that is broken but still parses is just
// one more version: it never replaces an older good one. The save only reads the agent folder, writes nothing else, and never
// throws: a failed save is a log line.
//
// Restore must load when the rest of the CLI cannot, so it imports node builtins and small files only; cli.ts dispatches it
// before cli-main.ts is loaded.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { loadEnv, paths } from './config.ts'
import { ensureDir, writeFileAtomic } from './fsutil.ts'

/** Everything that is saved, and nothing else. Paths are relative to the agent folder and to a version folder. */
export const LAST_GOOD_FILES = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'] as const
type Rel = (typeof LAST_GOOD_FILES)[number]

/** How many versions are kept. */
export const LAST_GOOD_KEEP = 10
/** The newest start versions that are always kept, however many restore backups there are. */
export const LAST_GOOD_KEEP_STARTS = 3
/** A setup file larger than this is not saved or restored. */
const MAX_BYTES = 1024 * 1024
const NAME = /^\d{8}T\d{9}Z$/

type Warn = { warn(msg: string, fields?: Record<string, unknown>): void }

/**
 * The agent folder the server serves. The server is started as `bun run --cwd <bridge folder>`, so its working folder is the
 * bridge's own and says nothing about the agent; `talos-app install-mcp` records the folder in the .mcp.json entry's env as
 * TALOS_AGENT_DIR, and this is the only place it is read.
 */
export function agentDirFromEnv(env: Record<string, string | undefined>): string | undefined {
  const v = env.TALOS_AGENT_DIR
  return v && isAbsolute(v) ? v : undefined
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Raw = { ok: true; text: string } | { ok: false; why: 'missing' | 'irregular' | 'big' }

/** The text of a setup file as it is, following a symlink. No judgement about the content. */
function readRaw(path: string): Raw {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return { ok: false, why: 'missing' }
  }
  if (!st.isFile()) return { ok: false, why: 'irregular' }
  if (st.size > MAX_BYTES) return { ok: false, why: 'big' }
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch {
    return { ok: false, why: 'missing' }
  }
}

type Bad = 'empty' | 'invalid' | 'shape'
const DESCRIBE = {
  empty: 'is empty',
  invalid: 'does not parse',
  shape: 'is not the right shape',
  missing: 'is missing',
  irregular: 'is not a regular file',
  big: 'is over 1 MB',
} as const

/** Light check: parses; .mcp.json is an object whose mcpServers, if present, is an object; a settings file is an object. */
function check(rel: Rel, text: string): Bad | undefined {
  if (text.trim() === '') return 'empty'
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return 'invalid'
  }
  if (!isObject(v)) return 'shape'
  if (rel === '.mcp.json' && v.mcpServers !== undefined && !isObject(v.mcpServers)) return 'shape'
  return undefined
}

export type Version = {
  name: string
  path: string
  /** ISO time it was saved. */
  savedAt: string
  /** The agent folder it was taken from. */
  agentDir: string
  files: Rel[]
  /** `start`: saved after a healthy start. `restore`: the files a restore was about to replace. */
  source: 'start' | 'restore'
}

function stampMs(n: string): number {
  return Date.UTC(
    +n.slice(0, 4),
    +n.slice(4, 6) - 1,
    +n.slice(6, 8),
    +n.slice(9, 11),
    +n.slice(11, 13),
    +n.slice(13, 15),
    +n.slice(15, 18),
  )
}

/** A folder named more than a day ahead of the clock is foreign: made up, not a version. It is never numbered, listed, restored, trimmed or counted. */
function isForeign(name: string, nowMs: number): boolean {
  const t = stampMs(name)
  return !Number.isNaN(t) && t > nowMs + 86_400_000
}

/** The saved versions, newest first, and the folders that look like versions but cannot be read. Foreign (far-future) folders are left out of both. */
export function listVersions(dir: string, nowMs: number = Date.now()): { versions: Version[]; unreadable: string[] } {
  const versions: Version[] = []
  const unreadable: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => NAME.test(n) && !isForeign(n, nowMs))
  } catch {
    return { versions, unreadable }
  }
  for (const name of names.sort().reverse()) {
    const path = join(dir, name)
    try {
      if (!statSync(path).isDirectory()) continue
      const m: unknown = JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8'))
      if (!isObject(m) || typeof m.agent_dir !== 'string' || !isAbsolute(m.agent_dir)) throw new Error('agent_dir')
      if (typeof m.saved_at !== 'string' || Number.isNaN(Date.parse(m.saved_at))) throw new Error('saved_at')
      if (!Array.isArray(m.files) || !m.files.every((f) => (LAST_GOOD_FILES as readonly unknown[]).includes(f)))
        throw new Error('files')
      versions.push({
        name,
        path,
        savedAt: m.saved_at,
        agentDir: m.agent_dir,
        files: m.files as Rel[],
        source: m.source === 'restore' ? 'restore' : 'start',
      })
    } catch {
      unreadable.push(name)
    }
  }
  return { versions, unreadable }
}

function readVersionFile(v: Version, rel: Rel): Raw {
  return readRaw(join(v.path, rel))
}

/** Writes one version folder (built aside, then renamed in, so a crash leaves no half version) and trims the history. */
function writeVersion(o: {
  dir: string
  agentDir: string
  files: Partial<Record<Rel, string>>
  source: 'start' | 'restore'
  now: () => Date
  log?: Warn
}): string {
  ensureDir(o.dir)
  const now = o.now().getTime()
  // The newest name decides where the new one sorts, but a folder name can be made up (mkdir 99991231T...): one more than a
  // day ahead of the clock is ignored, so a made-up name cannot push every later save into the far future.
  let newestMs = Number.NEGATIVE_INFINITY
  for (const n of readdirSync(o.dir).filter((x) => NAME.test(x))) {
    const t = stampMs(n)
    if (Number.isNaN(t)) continue
    if (t > now + 86_400_000)
      o.log?.warn(`last-good: ignored a version folder named ${n}, it is more than a day in the future`, { folder: n })
    else if (t > newestMs) newestMs = t
  }
  const ms = Math.max(now, newestMs + 1) // names sort by time even if the clock went back
  const stampOf = (t: number) => new Date(t).toISOString().replace(/[-:.]/g, '')
  const name = stampOf(ms)
  const tmp = join(o.dir, `.tmp-${Math.random().toString(36).slice(2)}`)
  try {
    ensureDir(tmp)
    const present = LAST_GOOD_FILES.filter((rel) => o.files[rel] !== undefined)
    for (const rel of present) writeFileAtomic(join(tmp, rel), o.files[rel] as string, 0o600)
    const meta = { v: 1, agent_dir: o.agentDir, saved_at: new Date(ms).toISOString(), files: present, source: o.source }
    writeFileAtomic(join(tmp, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 0o600)
    renameSync(tmp, join(o.dir, name))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  // Keep the newest few start versions first, then fill up to the limit with the newest of the rest, so many restore backups
  // cannot push out every version the bridge saved after a healthy start.
  const kept = new Set<string>([name]) // the version just written is never trimmed
  for (const v of listVersions(o.dir, now)
    .versions.filter((v) => v.source === 'start')
    .slice(0, LAST_GOOD_KEEP_STARTS))
    kept.add(v.name)
  const all = readdirSync(o.dir)
    .filter((n) => NAME.test(n) && !isForeign(n, now)) // foreign folders are left alone, not counted, not deleted
    .sort()
    .reverse()
  for (const n of all) if (kept.size < LAST_GOOD_KEEP) kept.add(n)
  for (const old of all) if (!kept.has(old)) rmSync(join(o.dir, old), { recursive: true, force: true })
  return name
}

/** Saves a new version when the setup differs from the newest one. Reads the agent folder only. Never throws. */
export function saveLastGood(o: { agentDir: string; dir: string; log: Warn; now?: () => Date }): void {
  try {
    const files: Partial<Record<Rel, string>> = {}
    for (const rel of LAST_GOOD_FILES) {
      const r = readRaw(join(o.agentDir, rel))
      if (!r.ok) {
        if (r.why !== 'missing') o.log.warn(`last-good: ${rel} not saved, it ${DESCRIBE[r.why]}`, { file: rel })
        continue
      }
      const bad = check(rel, r.text)
      if (bad) {
        o.log.warn(`last-good: ${rel} not saved, it ${DESCRIBE[bad]}`, { file: rel })
        continue
      }
      files[rel] = r.text
    }
    const present = LAST_GOOD_FILES.filter((rel) => files[rel] !== undefined)
    if (present.length === 0) return
    const at = (o.now ?? (() => new Date()))() // read the clock once
    const newest = listVersions(o.dir, at.getTime()).versions[0]
    if (
      newest &&
      newest.agentDir === o.agentDir &&
      newest.files.length === present.length &&
      present.every((rel) => {
        const saved = readVersionFile(newest, rel)
        return saved.ok && saved.text === files[rel]
      })
    )
      return
    writeVersion({
      dir: o.dir,
      agentDir: o.agentDir,
      files,
      source: 'start',
      now: () => at,
      log: o.log,
    })
  } catch (e) {
    o.log.warn('last-good: save failed', { error: (e as Error).message })
  }
}

export type RestoreIo = {
  out(line: string): void
  err(line: string): void
  prompt(question: string): Promise<string>
}

/** A symlinked folder (/var -> /private/var) must compare equal to the path it was saved under. */
function realpathOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Where a write to `p` lands: every link on the way is followed, one hop at a time, including a link whose target does not
 * exist yet (a plain realpath gives up on that and the write would replace the link with a file).
 */
function through(p: string, hops = { n: 0 }): string {
  const parent = dirname(p)
  if (parent === p) return p
  const full = join(through(parent, hops), basename(p))
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(full)
  } catch {
    return full
  }
  if (!st.isSymbolicLink()) return full
  if (++hops.n > 40) throw new Error(`${p} is in a loop of symlinks`)
  return through(resolve(dirname(full), readlinkSync(full)), hops)
}

/** True when something (a file, a link, a folder) is at the path, even a broken link. */
const statExists = (p: string) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * The `.claude` folder, if it is a symlink to somewhere outside the agent folder, would make a restore write into that other
 * place; refuse that before anything is asked or written. A setup FILE that is a link is different: owners keep
 * `.mcp.json` or `.claude/settings.json` as a link into a dotfiles folder on purpose, so it is written through (the link
 * stays) and the line printed names the real file. Only a dangling file link whose target is outside is refused, since
 * writing would create something there; that message names the saved copy so it can be copied by hand. Returns, per file
 * written through a link, the real path. Removing a file only unlinks it, but its folder still must not lead outside.
 */
function checkLinks(agentDir: string, savedDir: string, plan: { rel: string; remove?: true }[]): Map<string, string> {
  const root = through(agentDir)
  const inside = (t: string) => t === root || t.startsWith(root + sep)
  const isLink = (p: string) => {
    try {
      return lstatSync(p).isSymbolicLink()
    } catch {
      return false
    }
  }
  const claude = join(agentDir, '.claude')
  const via = new Map<string, string>()
  for (const p of plan) {
    const path = join(agentDir, p.rel)
    const target = p.remove ? join(through(dirname(path)), basename(path)) : through(path)
    const viaFolder = p.rel.startsWith('.claude/') && isLink(claude) && !inside(through(claude))
    if (viaFolder)
      throw new Error(
        `${claude} is a symlink to ${through(claude)}, outside the agent folder, so restoring through it would write there. Nothing was written. ` +
          `Either replace the link with a real .claude folder in ${agentDir}, or restore only the other file with --file .mcp.json.`,
      )
    if (inside(target)) continue
    if (p.remove) continue // unlinking the file itself touches nothing outside
    if (isLink(path) && existsSync(target)) {
      via.set(p.rel, target)
      continue
    }
    throw new Error(
      `${path} is a symlink to ${target}, outside the agent folder, and nothing is there yet, so restoring would create a file there. Nothing was written. ` +
        `The saved copy is ${join(savedDir, p.rel)}; copy it into place by hand.`,
    )
  }
  return via
}

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** The command: put a saved version back into the agent folder it came from. Returns the exit code. */
export async function restoreLastGood(
  args: string[],
  io: RestoreIo,
  envOverride?: Record<string, string | undefined>,
): Promise<number> {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'agent-dir': { type: 'string' },
        yes: { type: 'boolean' },
        list: { type: 'boolean' },
        version: { type: 'string' },
        file: { type: 'string' },
        'newest-start': { type: 'boolean' },
      },
      strict: true,
    })
    const dir = join(paths(loadEnv(envOverride ?? process.env).home).home, 'last-good')
    const { versions, unreadable } = listVersions(dir)
    if (versions.length === 0)
      throw new Error(`nothing saved yet in ${dir}. A copy is saved after the bridge starts cleanly.`)

    io.out('restore-last-good: saved versions, newest first:')
    versions.forEach((v, i) => {
      const note = v.source === 'restore' ? ' (the files a restore replaced)' : ''
      io.out(`  ${i + 1}. ${when(v.savedAt)}  ${v.files.join(', ')}${note}`)
      io.out(`     from ${v.agentDir}`)
    })
    if (unreadable.length)
      io.out(
        `  (skipped ${unreadable.length} unreadable version folder${unreadable.length === 1 ? '' : 's'}: ${unreadable.join(', ')})`,
      )
    if (values.list) return 0

    if (values['newest-start'] && (values.version !== undefined || values.file !== undefined))
      throw new Error('--newest-start cannot be combined with --version or --file.')
    let only: Rel | undefined
    if (values.file !== undefined) {
      only = LAST_GOOD_FILES.find((f) => f === values.file)
      if (!only) throw new Error(`--file must be one of: ${LAST_GOOD_FILES.join(', ')}`)
    }
    const wanted = (v: Version): Rel[] => (only ? v.files.filter((f) => f === only) : v.files)
    // a setup file that exists now but is not in the version: it is part of what the version would change
    const extras = (v: Version): Rel[] =>
      LAST_GOOD_FILES.filter(
        (rel) => (!only || rel === only) && !v.files.includes(rel) && statExists(join(v.agentDir, rel)),
      )
    const differs = (v: Version) =>
      extras(v).length > 0 ||
      wanted(v).some((rel) => {
        const saved = readVersionFile(v, rel)
        const cur = readRaw(join(v.agentDir, rel))
        return !(saved.ok && cur.ok && saved.text === cur.text)
      })

    let version: Version | undefined
    let number = 0
    if (values.version !== undefined) {
      const n = /^\d+$/.test(values.version) ? Number(values.version) : 0
      version = versions[n - 1]
      number = n
      if (!version) throw new Error(`no version ${values.version}; the list above has 1 to ${versions.length}`)
    } else {
      // --newest-start (the Mac app's automatic restore): the newest start version or nothing, never an older one to fall back to
      const i = versions.findIndex((v) => v.source === 'start' && (values['newest-start'] || differs(v)))
      if (i < 0) {
        io.out('restore-last-good: the agent folder already matches the saved versions. Nothing to do.')
        return 0
      }
      version = versions[i]
      number = i + 1
    }
    if (!version) throw new Error('no version to restore')
    if (version.source === 'restore')
      io.out(
        `restore-last-good: note: version ${number} is a pre-restore backup (it holds what an earlier restore replaced), restoring it because you named it.`,
      )
    const agentDir = version.agentDir
    if (values['agent-dir'] !== undefined && realpathOr(values['agent-dir']) !== realpathOr(agentDir))
      throw new Error(
        `version ${number} was saved from ${agentDir}, not ${resolve(values['agent-dir'])}. Nothing was written.`,
      )
    if (!existsSync(agentDir)) throw new Error(`the agent folder this version came from no longer exists: ${agentDir}`)
    if (only && !version.files.includes(only) && extras(version).length === 0)
      throw new Error(
        `version ${number} has no ${only}, and there is none in the agent folder; it has ${version.files.join(', ')}`,
      )

    type Step = { rel: Rel; text: string; before: string | null; remove?: true }
    const plan: Step[] = []
    for (const rel of wanted(version)) {
      const saved = readVersionFile(version, rel)
      if (!saved.ok)
        throw new Error(
          `the saved copy of ${rel} ${DESCRIBE[saved.why]} (${join(version.path, rel)}), so nothing was restored.`,
        )
      const bad = version.source === 'start' ? check(rel, saved.text) : undefined
      if (bad)
        throw new Error(
          `the saved copy of ${rel} ${DESCRIBE[bad]} (${join(version.path, rel)}), so nothing was restored. Fix or delete that file.`,
        )
      const cur = readRaw(join(agentDir, rel))
      if (!cur.ok && cur.why !== 'missing')
        throw new Error(`${join(agentDir, rel)} ${DESCRIBE[cur.why]}; it was not touched and nothing was restored.`)
      if (cur.ok && cur.text === saved.text) continue
      plan.push({ rel, text: saved.text, before: cur.ok ? cur.text : null })
    }
    for (const rel of extras(version)) {
      const cur = readRaw(join(agentDir, rel))
      if (!cur.ok)
        throw new Error(`${join(agentDir, rel)} ${DESCRIBE[cur.why]}; it was not touched and nothing was restored.`)
      plan.push({ rel, text: '', before: cur.text, remove: true })
    }
    if (plan.length === 0) {
      io.out('restore-last-good: the agent folder already matches that version. Nothing to do.')
      return 0
    }
    // Name the real file a link leads to before the question, so the owner approves the write they will get.
    const shownVia = checkLinks(agentDir, version.path, plan)
    io.out(`restore-last-good: will put back version ${number} (${when(version.savedAt)}) in ${agentDir}:`)
    for (const p of plan) {
      const real = shownVia.get(p.rel)
      io.out(
        p.remove
          ? `  ${p.rel} (not in this version: will be moved aside; a copy goes into the backup version)`
          : `  ${p.rel} (now ${p.before === null ? 'missing' : 'different'})${real ? `: it is a link, so this writes ${real}, outside the agent folder` : ''}`,
      )
    }
    // --yes skips the question, never this line: a restore that leaves the agent folder must be seen by whoever ran it
    if (values.yes)
      for (const [rel, real] of shownVia)
        io.err(`talos-app: warning: ${rel} is a link, so this restore writes ${real}, outside the agent folder.`)
    if (!values.yes) {
      const answer = (await io.prompt('Replace these with the saved copies? [y/N] ')).trim()
      if (!/^y(es)?$/i.test(answer)) throw new Error('not confirmed, so nothing was changed.')
    }

    const unchanged = (p: Step) => {
      const t = through(join(agentDir, p.rel))
      const now = existsSync(t) ? readRaw(t) : ({ ok: false, why: 'missing' } as const)
      return p.before === null ? !now.ok && now.why === 'missing' : now.ok && now.text === p.before
    }
    const moved = plan.find((p) => !unchanged(p))
    if (moved)
      throw new Error(`${moved.rel} changed while waiting for your answer; nothing was written. Run the command again.`)

    // what is about to be replaced goes into the history first, so this restore can itself be undone
    const before: Partial<Record<Rel, string>> = {}
    for (const rel of LAST_GOOD_FILES) {
      const step = plan.find((p) => p.rel === rel)
      const cur = step ? { ok: step.before !== null, text: step.before ?? '' } : readRaw(join(agentDir, rel))
      if (cur.ok) before[rel] = cur.text
    }
    let backupName: string | undefined
    if (Object.keys(before).length > 0) {
      try {
        backupName = writeVersion({
          dir,
          agentDir,
          files: before,
          source: 'restore',
          now: () => new Date(),
          log: { warn: (m) => io.err(m) },
        })
      } catch (e) {
        throw new Error(`could not save the current files first (${(e as Error).message}); nothing was written.`)
      }
    }

    // a path can become a link while the question was open: look again right before writing
    const via = checkLinks(agentDir, version.path, plan)
    const written: string[] = []
    for (const [i, p] of plan.entries()) {
      try {
        if (!unchanged(p)) throw new Error('it changed just now')
        if (p.remove) {
          unlinkSync(join(agentDir, p.rel)) // the file (or the link), not what a link points at
          written.push(`${p.rel} (moved aside)`)
          continue
        }
        const target = through(join(agentDir, p.rel))
        mkdirSync(dirname(target), { recursive: true })
        const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
        writeFileAtomic(target, p.text, mode)
        const real = via.get(p.rel)
        if (real) io.out(`restore-last-good: wrote ${p.rel} (through the link to ${real})`)
        written.push(p.rel)
      } catch (e) {
        io.out(`restore-last-good: wrote ${written.length ? written.join(', ') : 'nothing'}`)
        const rest = plan.slice(i + 1).map((x) => x.rel)
        io.err(
          `talos-app: could not write ${p.rel}: ${(e as Error).message}.${rest.length ? ` Not attempted: ${rest.join(', ')}.` : ''}`,
        )
        return 1
      }
    }
    // the backup's real number in the list the owner will see, never a constant
    const backupNumber = backupName ? listVersions(dir).versions.findIndex((v) => v.name === backupName) + 1 : 0
    const saved =
      backupNumber > 0
        ? ` The files it replaced are saved as version ${backupNumber} (talos-app restore-last-good --version ${backupNumber} puts them back).`
        : ''
    // One stable line for the Mac app, which parses it strictly: the files, then the date the version was saved.
    io.out(`restore-last-good: restored ${written.join(', ')} from the version saved ${when(version.savedAt)}`)
    io.out(
      `restore-last-good: wrote ${written.length} file${written.length === 1 ? '' : 's'}: ${written.join(', ')}.${saved} Restart the agent to use the restored ones.`,
    )
    return 0
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    return 1
  }
}
