// The OS sandbox and the session's own folder (guards/os-sandbox.ts). The folder is the session's cwd, so it is writable, and in it
// sit the files Claude Code RUNS OUTSIDE the sandbox: the hook scripts and the status line in `.claude/settings.json`, the MCP servers
// in `.mcp.json`, and the folders the kit links in (`hooks`, `scripts`). A session that could replace one would run its own code
// unsandboxed at the next tool call. So (1) those files are unwritable (the sandbox's `denyWrite`), each by the folder's real path
// and the file's own name (a symlink is denied by its own name: denying its target does not stop `rm` of the link, found by a real
// run); (2) a start is refused when the kit's link is already gone (the hooks would silently not run); (3) a start is refused when a
// project, local or user settings file carries a sandbox key that is not on the short allow-list (SANDBOX_KEYS_OK), or makes folders
// writable inside the lock (additionalDirectories, an Edit or Write allow rule with a path); (4) a start is refused when a hook, the
// status line or an MCP server runs something the session could change (commandsProblem: only the kit's own from the folder's files,
// only an absolute file outside every writable place from the owner's user settings).
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { bridgeBunfig, bridgeServer, bunPath } from '../mcp-config.ts'
import { realFileSync } from '../real-file.ts'
import { kitVendorDir } from '../talos.ts'

type Json = Record<string, unknown>

/** Names in a session's folder that are protected when they exist (the kit's links, the settings, the instruction files, a lead's marker). */
const FOLDER_NAMES = ['hooks', 'scripts', 'kit', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.talos-lead'] as const
/** Protected even when absent: a session that created either would have settings or servers run outside the sandbox. Both are in the git excludes. */
const ALWAYS_NAMES = ['.claude', '.mcp.json'] as const
/** What `bun <script>` loads from the working folder: denied for writing even when missing (`.env.*` as a pattern). */
const BUN_INPUTS = ['bunfig.toml', '.env', '.env.*'] as const
/** The kit folders the settings' hooks run scripts from. */
const KIT_LINKS = ['hooks', 'scripts'] as const
/** The names the kit install links into the release (`kit` too where present). */
const KIT_NAMES = ['hooks', 'scripts', 'kit'] as const

/** Entries looked at in a protected folder at most (a folder with more is refused, never skipped). */
export const WALK_CAP = 5000

/** Why `path` (named `shown`) cannot be protected, or null: a link, a file with another name, or a thing that is neither file nor folder. */
export function entryProblem(path: string, shown: string, budget: { left: number }): string | null {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch (e) {
    return (e as { code?: string }).code === 'ENOENT'
      ? null
      : `${shown} cannot be read (${(e as Error).message}); fix its permissions, then start again`
  }
  if (st.isSymbolicLink()) return `${shown} is a symbolic link; remove it, then start again`
  if (st.isDirectory()) {
    let names: string[]
    try {
      names = readdirSync(path)
    } catch (e) {
      return `${shown} cannot be listed (${(e as Error).message}); fix its permissions, then start again`
    }
    for (const n of names) {
      if (--budget.left < 0) return `${shown} holds too many entries to check; clear it out, then start again`
      const why = entryProblem(join(path, n), `${shown}/${n}`, budget)
      if (why) return why
    }
    return null
  }
  // inside the sandbox a protected name that does not exist is mounted as an empty character device (it is how the sandbox hides
  // it); making one on a real disk needs root, so it is no way round the check: a session that runs `talos-app sandbox status` or
  // doctor there must not read its own placeholders as a problem
  if (st.isCharacterDevice()) return null
  if (!st.isFile()) return `${shown} is not a regular file; remove it, then start again`
  if (st.nlink !== 1)
    return `${shown} has another name on this disk (a hard link); remove the other link, then start again`
  return null
}

const objOf = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false

function readJson(path: string): Json | null {
  try {
    return existsSync(path) ? objOf(JSON.parse(readFileSync(path, 'utf8'))) : null
  } catch {
    return null
  }
}

const lstatOk = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** The settings files a session loads from `folder` that it could write: project and local. */
const projectSettings = (dir: string): Array<[string, string]> =>
  ['settings.json', 'settings.local.json'].map((n) => [n, join(dir, '.claude', n)])

/** Every command string of a settings object: hooks, the status line, and the helpers Claude Code runs. */
function settingsCommands(s: Json): string[] {
  const out: string[] = []
  const hooks = objOf(s.hooks)
  for (const event of Object.keys(hooks).sort()) {
    const groups = hooks[event]
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of Array.isArray(objOf(g).hooks) ? (objOf(g).hooks as unknown[]) : [])
        if (typeof objOf(h).command === 'string') out.push(objOf(h).command as string)
  }
  const line = objOf(s.statusLine).command
  if (typeof line === 'string') out.push(line)
  for (const k of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'])
    if (typeof s[k] === 'string') out.push(s[k] as string)
  return out
}

/** The words of a shell command line that may name a file: quotes, `;`, `|`, `&`, `(`, `)`, `=` and `{`/`}` of `${..}` taken apart. */
function words(cmd: string, folder: string): string[] {
  // the project folder variable, with a quote that closes right after it (`"$CLAUDE_PROJECT_DIR"/tools/x`), becomes the folder
  return cmd
    .replaceAll(/\$\{CLAUDE_PROJECT_DIR\}["']?|\$CLAUDE_PROJECT_DIR["']?/g, folder)
    .split(/[\s"'`;|&()<>=]+/)
    .filter((w) => w.length > 1)
}

/** This bridge clone (the talos-app MCP entry runs from it): outside the session folder, and not writable from the sandbox. */
const BRIDGE_DIR = resolve(import.meta.dir, '..', '..')
const SCRIPT_EXT = /\.(?:py|sh|js|mjs|cjs|ts|rb|pl)$/

/** `p` with every folder on its way resolved (the deepest one that exists, the rest as written); its own name is kept. */
export function realName(p: string): string {
  const rest: string[] = []
  let d = dirname(p)
  for (;;) {
    try {
      return join(realFileSync(d), ...rest.reverse(), basename(p))
    } catch {
      const up = dirname(d)
      if (up === d) return p
      rest.push(basename(d))
      d = up
    }
  }
}

/** A file's real path: links followed when it exists, else its folders resolved. */
const realOf = (p: string): string => {
  try {
    return realFileSync(p)
  } catch {
    return realName(p)
  }
}

/** The shared temp folders, by real path: every program writes there, so nothing in one can stand in for a fixed file. */
export function tempRoots(): string[] {
  const real = (t: string): string | null => {
    try {
      return realFileSync(t)
    } catch {
      return null
    }
  }
  return [
    ...new Set(
      [process.env.TMPDIR, tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
        .filter((t): t is string => !!t)
        .map(real)
        .filter((t): t is string => t !== null && t !== '/'),
    ),
  ]
}

const under = (p: string, dir: string): boolean => p === dir || p.startsWith(`${dir}/`)

/** The files a command line names, as real paths: a word that is an absolute or folder-relative path to what exists, or a script by name. */
function namedFiles(cmd: string, folder: string): string[] {
  const out: string[] = []
  for (const w of words(cmd, folder)) {
    let abs: string | null = null
    if (isAbsolute(w)) abs = w
    else if (w.startsWith('./') || (w.includes('/') && !w.startsWith('$') && !w.startsWith('-')))
      abs = resolve(folder, w)
    else if (SCRIPT_EXT.test(w)) abs = resolve(folder, w)
    if (!abs || abs.includes('$') || abs === folder) continue
    const real = realOf(abs)
    if (lstatOk(real) || SCRIPT_EXT.test(real)) out.push(real)
  }
  return out
}

/** The stdio MCP servers of a `.mcp.json` (an http or sse server runs nowhere here: it is not listed), by name, as command lines. */
function mcpServers(dir: string): Array<{ name: string; cmd: string; entry: Json }> {
  const servers = objOf(readJson(join(dir, '.mcp.json'))?.mcpServers)
  return Object.entries(servers).flatMap(([name, v]) => {
    const s = objOf(v)
    if (typeof s.command !== 'string' || s.type === 'http' || s.type === 'sse') return []
    const cmd = [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x) => typeof x === 'string').join(' ')
    return [{ name, cmd, entry: s }]
  })
}

/** What Talos recorded about its own bridge (the record): the bun it runs and the bridge folder of its clone (`<clone>/apps/bridge`). */
export type TrustedBridge = { bun: string; bridgeDir: string }

/**
 * The record, as this process knows it: the bun it finds on its PATH or runs on, and the clone it runs from. null when there is none
 * to trust: no absolute bun, or the clone sits in a shared temp folder (a place every program can write to). Built here, once per
 * launch, outside the pure folder checks (which take the record as given, so a test or the Mac's recipe can name another).
 */
export function trustedBridge(): TrustedBridge | null {
  const bun = [bunPath(), process.execPath].find((b) => isAbsolute(b) && /^bun(-|$)/.test(basename(b)))
  if (!bun || tempRoots().some((t) => under(realOf(BRIDGE_DIR), t))) return null
  return { bun, bridgeDir: BRIDGE_DIR }
}

/** What the launch gives the folder checks besides the folder: the owner's home, the Talos home, and the record (undefined: build it). */
export type LaunchContext = { userHome?: string; talosHome?: string; trusted?: TrustedBridge | null }

/** The env keys the talos-app entry may carry: the two `mcpEntry` writes. Anything else (BUN_OPTIONS, NODE_OPTIONS, PATH, ...) changes what runs. */
const TALOS_ENTRY_ENV = ['TALOS_APP_HOME', 'TALOS_AGENT_DIR']

/**
 * The `talos-app` stdio entry of a project `.mcp.json`, which every agent folder has. MCP servers are not sandboxed, and `bun <script>`
 * run from the session folder loads that folder's `bunfig.toml` (its `preload` is code) and `.env`; so the entry is allowed only in the
 * form Talos writes (`mcpEntry`: `<bun> --no-env-file --config=<bridge>/bunfig.toml <bridge>/src/server.ts`) and only when each part,
 * by real path, is what the record says (never what the entry says of itself): no `cwd`, an env of only TALOS_APP_HOME (this home) and
 * TALOS_AGENT_DIR, and a recorded clone outside the session folder. The old form (`run --cwd ...`) is "in the old form"; any other
 * refuses with what is wrong. One plain line naming the file, or null.
 */
function talosEntryProblem(
  file: string,
  entry: Json,
  folder: string,
  talosHome: string | undefined,
  trusted: TrustedBridge | null,
): string | null {
  const args = Array.isArray(entry.args) ? entry.args : []
  if (args[0] === 'run' && args.includes('--cwd'))
    return `${file} has a talos-app server in the old form; run talos-app doctor to rewrite it, then start again`
  const no = (why: string) =>
    `${file} has a talos-app server that is not Talos's own (${why}); run talos-app adopt for this folder, then start again`
  if (!trusted)
    return `${file} has a talos-app server, and Talos can't confirm which bridge this folder runs (the guards aren't installed); install them from Settings, then start again`
  const bridge = realOf(trusted.bridgeDir)
  if (under(bridge, folder)) return no('the bridge Talos recorded is inside the session folder')
  if ('cwd' in entry) return no('it sets cwd')
  const env = objOf(entry.env)
  for (const [k, v] of Object.entries(env))
    if (!TALOS_ENTRY_ENV.includes(k)) return no(`its env sets ${k}`)
    else if (typeof v !== 'string' || (k === 'TALOS_APP_HOME' && talosHome && realOf(v) !== realOf(talosHome)))
      return no(`its env sets ${k} to something else`)
  if (typeof entry.command !== 'string' || realOf(entry.command) !== realOf(trusted.bun))
    return no('its command is not the bun Talos uses')
  const conf = typeof args[1] === 'string' && args[1].startsWith('--config=') ? args[1].slice('--config='.length) : null
  if (
    args.length !== 3 ||
    args[0] !== '--no-env-file' ||
    conf === null ||
    realOf(conf) !== realOf(bridgeBunfig(bridge))
  )
    return no('it is not `--no-env-file --config=<bridge>/bunfig.toml <bridge>/src/server.ts`')
  if (typeof args[2] !== 'string' || realOf(args[2]) !== realOf(bridgeServer(bridge)))
    return no("its script is not Talos's bridge")
  return null
}

/** Interpreters that run a script named by their first path argument. */
const INTERPRETERS = /^(?:python[\d.]*|node|deno|bun|tsx|bash|sh|zsh|dash|ruby|perl|php)$/

/** Is the owner's user-settings command fixed in place: an absolute file the session cannot write, in a form that does not depend on where it starts? */
function userCommandOk(cmd: string, writable: readonly string[]): boolean {
  const t = cmd
    .trim()
    .split(/\s+/)
    .map((x) => x.replace(/^["']|["']$/g, ''))
  while (t[0] && /^[A-Za-z_]\w*=/.test(t[0])) t.shift()
  const prog = t[0] ?? ''
  const base = basename(prog)
  if (
    /^(?:npx|uvx|bunx|pnpx)$/.test(base) ||
    (base === 'bun' && t[1] === 'x') ||
    (/^python[\d.]*$/.test(base) && t.includes('-m'))
  )
    return false
  const outside = (f: string) => isAbsolute(f) && !writable.some((d) => under(realOf(f), d))
  // bun reads the working folder's `bunfig.toml` and `.env` unless told not to: it needs both flags, the config being a file nobody can write
  if (base === 'bun') {
    const conf = t.find((x) => x.startsWith('--config='))?.slice('--config='.length)
    if (!t.includes('--no-env-file') || !conf || !outside(conf)) return false
  }
  let file = prog
  if (INTERPRETERS.test(base)) file = t.slice(1).find((x) => !x.startsWith('-') && x !== 'run') ?? ''
  return outside(file)
}

/**
 * A lead's hook script (what `lead init` copies into the folder): a regular file directly in `<folder>/.claude/hooks` that is byte for
 * byte the kit's template of the same name in the recorded clone (`<clone>/kit/templates/lead`). Where a file sits counts for nothing on
 * its own; with no recorded bridge there is no template to compare with, so none passes.
 */
function leadHook(file: string, folder: string, trusted: TrustedBridge | null): boolean {
  const dir = join(folder, '.claude', 'hooks')
  if (!trusted || dirname(file) !== dir) return false
  try {
    if (!lstatSync(file).isFile() || lstatSync(dir).isSymbolicLink()) return false
    const template = join(realOf(trusted.bridgeDir), '..', '..', 'kit', 'templates', 'lead', basename(file))
    return readFileSync(file).equals(readFileSync(template))
  } catch {
    return false
  }
}

/**
 * What runs outside the sandbox must not be something the session can touch. With the switch on, a hook, the status line, a helper
 * command or a stdio MCP server named in a PROJECT or LOCAL settings file (the folder's or its git root's) or `.mcp.json` is allowed only
 * when it is the kit release's own (its files are inside the kit's real folder) or a lead's hook script (leadHook: the kit's template,
 * byte for byte), the one exception being the talos-app MCP entry in its exact current form (talosEntryProblem);
 * any other refuses the start, naming it. From the owner's USER settings a command is allowed only as an absolute path to a file (alone
 * or run by an interpreter) outside the session folder and every temp folder, in a form that does not depend on where it starts (no
 * npx, uvx, bunx, `bun x`, `python -m`, relative script; bun with `--no-env-file` and `--config=<such a file>`). http and sse MCP
 * servers run nowhere here.
 */
function commandsProblem(folder: string, claudeDir: string, loadsProject: boolean, ctx: LaunchContext): string | null {
  const kit = realOf(kitVendorDir(process.env, ctx.userHome ?? homedir()))
  const trusted = ctx.trusted === undefined ? trustedBridge() : ctx.trusted
  const kitOwn = (cmd: string) => {
    const files = namedFiles(cmd, folder)
    return files.length > 0 && files.every((f) => under(f, kit) || leadHook(f, folder, trusted))
  }
  const notKits = (file: string, what: string) =>
    `${file} runs ${what}, which is not the kit's own; move it to your user settings (~/.claude/settings.json), then start again`
  if (loadsProject)
    for (const dir of new Set([folder, gitRoot(folder)])) {
      for (const [, file] of projectSettings(dir))
        for (const cmd of settingsCommands(readJson(file) ?? {})) if (!kitOwn(cmd)) return notKits(file, `"${cmd}"`)
      const mcp = join(dir, '.mcp.json')
      for (const { name, cmd, entry } of mcpServers(dir)) {
        const bad =
          name === 'talos-app'
            ? talosEntryProblem(mcp, entry, folder, ctx.talosHome, trusted)
            : kitOwn(cmd)
              ? null
              : notKits(mcp, `the ${name} server ("${cmd}")`)
        if (bad) return bad
      }
    }
  const writable = [folder, ...tempRoots()]
  const userFile = join(claudeDir, 'settings.json')
  for (const cmd of settingsCommands(readJson(userFile) ?? {}))
    if (!userCommandOk(cmd, writable))
      return `${userFile} runs "${cmd}", which the extra lock cannot allow (it must be an absolute path to a file outside the session folder and every folder a session can write, with no npx, uvx, bunx, bun x, -m or relative script); change it, then start again`
  return null
}

/**
 * What a session may not write inside `folder` (its real path): `.claude` and `.mcp.json` always, the protected names that exist (the
 * kit's links by their own name), and bun's own inputs, `bunfig.toml`, `.env` and `.env.*` (a program run from here by bun would load
 * them), whether or not they exist. Each path is the folder's real path and the name as it stands in the folder.
 */
export function folderDenyWrite(folder: string): string[] {
  const out = new Set<string>()
  for (const n of ALWAYS_NAMES) out.add(join(folder, n))
  for (const n of FOLDER_NAMES) if (lstatOk(join(folder, n))) out.add(join(folder, n))
  for (const n of BUN_INPUTS) out.add(join(folder, n))
  return [...out]
}

/** The folder's `hooks` or `scripts` link is gone while the settings still run scripts from it: the hooks would silently not run. */
export function folderKitProblem(folder: string): string | null {
  const commands = projectSettings(folder).flatMap(([, f]) => settingsCommands(readJson(f) ?? {}))
  // only a command that names the folder's OWN hooks/ or scripts/ needs the kit's link (a lead runs `.claude/hooks/...`)
  const names = (n: string) =>
    commands.some((c) =>
      words(c, folder).some((w) => (isAbsolute(w) ? w : resolve(folder, w)).startsWith(`${join(folder, n)}/`)),
    )
  for (const n of KIT_LINKS)
    if (names(n) && !lstatOk(join(folder, n)))
      return `${n} is missing from ${folder} (its link into the kit release is gone) while .claude/settings.json runs scripts from it, so the guards would silently not run; run the kit's install again, then start again`
  return null
}

/** The folder above `folder` that holds a `.git`, or `folder` itself when none does. */
function gitRoot(folder: string): string {
  for (let d = folder; ; d = dirname(d)) {
    if (lstatOk(join(d, '.git'))) return d
    if (dirname(d) === d) return folder
  }
}

/**
 * The `sandbox` keys a settings file the session loads may carry, and no others (Claude Code's own keys that open the sandbox change
 * with its versions, so a key not listed here is refused, a future one included): `autoAllowBashIfSandboxed` (only `false`, which is what
 * the lock itself sets), `ignoreViolations` (silences the violation log), `enabled` (only true) and
 * `failIfUnavailable` (only true): the same as what the lock itself sets. Ripgrep overrides, sockets, Apple events, credentials, proxy
 * and every filesystem or network key are not on it.
 */
const SANDBOX_KEYS_OK: Record<string, (v: unknown) => boolean> = {
  // only false: our own block says false (an old true would end Bash's approval cards); a true is refused, whatever the precedence
  autoAllowBashIfSandboxed: (v) => v === false,
  ignoreViolations: () => true,
  // only false (the lock's own value; real lead folders set it so)
  allowUnsandboxedCommands: (v) => v === false,
  enabled: (v) => v === true,
  failIfUnavailable: (v) => v === true,
}

/** The first `sandbox` key of a settings object (file `file`) that is not allowed, as the plain line, or null. */
function sandboxKeyProblem(file: string, s: Json | null): string | null {
  if (!s || !('sandbox' in s)) return null
  const sb = s.sandbox
  const bad =
    sb && typeof sb === 'object' && !Array.isArray(sb)
      ? Object.keys(sb).find((k) => !SANDBOX_KEYS_OK[k]?.((sb as Json)[k]))
      : ''
  return bad === undefined
    ? null
    : `${file} sets sandbox${bad ? `.${bad}` : ''}, which the extra lock does not allow (it could take a command out of the sandbox); remove it, then start again`
}

/** An Edit or Write allow rule that names a path: Claude Code makes that path a sandbox write root. */
const PATH_ALLOW = /^(?:Edit|Write|MultiEdit|NotebookEdit)\(\s*\S.*\)$/

/** A setting that makes a folder writable inside the lock (`additionalDirectories`, an Edit or Write allow rule with a path), as the plain line, or null. */
function writableRootProblem(file: string, s: Json | null): string | null {
  const perms = objOf(s?.permissions)
  if (nonEmpty(perms.additionalDirectories) || nonEmpty(s?.additionalDirectories))
    return `${file} sets permissions.additionalDirectories, which lets a session write outside its folder; remove it, then start again`
  const rule = (Array.isArray(perms.allow) ? perms.allow : []).find((r) => typeof r === 'string' && PATH_ALLOW.test(r))
  return rule
    ? `${file} allows "${rule}", a write to a path the sandbox does not decide; remove it, then start again`
    : null
}

/**
 * Settings that could take a command out of the sandbox: a `sandbox` key that is not on the allow-list (SANDBOX_KEYS_OK) in a project or
 * local settings file of the folder or its git root, or in the owner's user settings (every level the session loads). One plain line
 * naming the file and the key, or null.
 */
export function folderSettingsProblem(
  folder: string,
  claudeDir: string,
  o: { loadsProject: boolean } = { loadsProject: true },
): string | null {
  const dirs = o.loadsProject ? [...new Set([folder, gitRoot(folder)])] : []
  const files = [...dirs.flatMap((d) => projectSettings(d).map(([, f]) => f)), join(claudeDir, 'settings.json')]
  for (const file of files) {
    const settings = readJson(file)
    const why = sandboxKeyProblem(file, settings) ?? writableRootProblem(file, settings)
    if (why) return why
  }
  return null
}

/** Everything about the folder that refuses a start while the switch is on, or null. */
export const folderLaunchProblem = (
  folder: string,
  claudeDir: string,
  loadsProject = true,
  ctx: LaunchContext = {},
): string | null =>
  (loadsProject ? folderKitProblem(folder) : null) ??
  folderSettingsProblem(folder, claudeDir, { loadsProject }) ??
  folderLinkProblem(folder, kitVendorDir(process.env, ctx.userHome ?? homedir())) ??
  commandsProblem(folder, claudeDir, loadsProject, ctx)

/**
 * A file the session could write through another name: every existing path `folderDenyWrite` returns (the files inside, for a folder) must be a
 * regular file with link count 1. A hard link made earlier outside the sandbox (to /tmp, say) would let a sandboxed session write a hook
 * that runs unsandboxed. The kit's own links (`hooks`, `scripts`, `kit`) are links on purpose and point outside the folder: not walked.
 * One plain line naming the file relative to the folder, or null.
 */
export function folderLinkProblem(
  folder: string,
  kitDir: string = kitVendorDir(process.env, homedir()),
): string | null {
  const budget = { left: WALK_CAP }
  for (const p of folderDenyWrite(folder)) {
    const rel = relative(folder, p)
    // the kit's links are links on purpose, but only into the kit release: any other link at these names (to tmp, or back into the
    // folder) would run a session's own file outside the sandbox. A real folder at these names is walked like any other.
    if ((KIT_NAMES as readonly string[]).includes(rel) && isLink(p)) {
      if (!leadsInto(p, kitDir))
        return `${rel} is a symbolic link that does not lead into the kit release (${kitDir}); put the kit's link back (run the kit's install again), then start again`
      continue
    }
    const why = entryProblem(p, rel, budget)
    if (why) return why
  }
  return null
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** Does the link `p` lead to a place inside `dir` (both by real path)? A link that cannot be resolved does not. */
function leadsInto(p: string, dir: string): boolean {
  try {
    const target = realFileSync(p)
    const root = realFileSync(dir)
    return target === root || target.startsWith(`${root}/`)
  } catch {
    return false
  }
}
