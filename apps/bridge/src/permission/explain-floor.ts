// The deterministic floor under the plain explanation of a permission card. A model reads the command and may be steered,
// mistaken or fooled by what the command says about itself; this module works out, from the command text alone and with no
// model, the least severe tag the call can honestly wear. The shown tag is the more severe of the model's and this one, so a
// model that calls `rm -rf ~/x` harmless still shows "Deletes".
//
// It is a floor, not a verdict. It is conservative where it is cheap to be (an unreadable or built-up command word counts as
// "changes files"), it cannot see through a program it does not know (`./deploy.sh`), and a command that matches no rule has no
// floor (null), not "Reads files". Each finding carries `why`, a clause that is true of every call that earns it ("deletes
// files"); the card says it aloud when it overrides the model.
//
// The tag list is ordered least to most severe (EXPLAIN_TAGS), so "more severe" is "later in the list".
import { EXPLAIN_TAGS, type ExplainTag } from '@talos-app/protocol'
import {
  CHANGE_CMDS,
  CLOUD_CMDS,
  DELETE_CMDS,
  DESTROY_WORDS,
  FETCHERS,
  INLINE_FLAGS,
  INTERPRETERS,
  NPM_INSTALL,
  NPM_LIKE,
  NPM_VALUE_FLAGS,
  PKG_INSTALL,
  PUBLISH_CMDS,
  REMOVE_SUBS,
  RESERVED,
  SEND_CMDS,
  SHELLS,
  TEXT_CMDS,
  URL_RE,
  WRAPPERS,
  type Wrapper,
} from './explain-floor-tables.ts'
import { lex, type Seg, type Word } from './explain-lex.ts'

/**
 * One finding. `opaque` marks the finding that says "Talos cannot read this": a command word the shell builds, a call nested past
 * what is followed, a program that runs a command of its own. Such a call always counts as a mismatch.
 */
export type Floor = { tag: ExplainTag; why: string; opaque?: true }
type Found = Floor[]

const D = (why: string): Floor => ({ tag: 'Deletes', why })
const S = (why: string): Floor => ({ tag: 'Sends over the internet', why })
const I = (why: string): Floor => ({ tag: 'Installs', why })
const C = (why: string): Floor => ({ tag: 'Changes files', why })
/** A script or inline code that is run: a change at least, but the model can usually say what it does. */
const CODE = C('runs code that is not plainly shown')
const UNREAD = (why: string): Floor => ({ tag: 'Changes files', why, opaque: true })
const BUILT = UNREAD('builds its command from text that is not shown')
const TOO_DEEP = UNREAD('nests commands deeper than Talos follows')

const MAX_DEPTH = 6
const MAX_CHARS = 200_000
const rank = (t: ExplainTag) => EXPLAIN_TAGS.indexOf(t)

// ---- results ------------------------------------------------------------------------------------------------------------------

type R = { found: Found; network: boolean; stdinCode: boolean }
const none = (): R => ({ found: [], network: false, stdinCode: false })
const one = (f: Floor, network = false): R => ({ found: [f], network, stdinCode: false })
const many = (found: Found, network = false): R => ({ found, network, stdinCode: false })
const merge = (...rs: R[]): R => ({
  found: rs.flatMap((r) => r.found),
  network: rs.some((r) => r.network),
  stdinCode: rs.some((r) => r.stdinCode),
})

const baseOf = (t: string) => t.slice(t.lastIndexOf('/') + 1)
const isFlag = (t: string) => t.startsWith('-') && t.length > 1

/** The first non-flag word, skipping a flag's value for the flags in `values`. */
function firstOperand(
  args: string[],
  values: ReadonlySet<string> = new Set(),
): { word: string | undefined; rest: string[] } {
  for (let j = 0; j < args.length; j++) {
    const t = args[j] as string
    if (t === '--') return { word: args[j + 1], rest: args.slice(j + 2) }
    if (isFlag(t)) {
      if (values.has(t)) j++
      continue
    }
    return { word: t, rest: args.slice(j + 1) }
  }
  return { word: undefined, rest: [] }
}

// ---- the commands -------------------------------------------------------------------------------------------------------------

function unwrap(name: string, args: Word[]): Word[] {
  const spec = WRAPPERS[name] as Wrapper // the caller checked it is a key
  let j = 0
  while (j < args.length) {
    const t = (args[j] as Word).text
    if (t === '--') {
      j++
      break
    }
    if (!isFlag(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break
    j += spec.values.has(t) ? 2 : 1
  }
  for (let p = 0; p < spec.positional; p++) j++
  return args.slice(j)
}

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])
const REMOTE = 'reaches out over the internet'
const PROJECT = "changes the project's files or history"

function gitRules(args: string[], depth: number): R {
  // `git -c alias.x='!cmd' x` runs cmd
  const aliases: Found = []
  for (let j = 0; j < args.length - 1; j++) {
    if (args[j] !== '-c') continue
    const m = /^alias\.[^=]*=!(.*)$/s.exec(args[j + 1] as string)
    if (m) aliases.push(...analyze(m[1] as string, depth + 1))
  }
  const { word: sub, rest } = firstOperand(args, GIT_VALUE_FLAGS)
  const has = (...f: string[]) => rest.some((x) => f.includes(x))
  const sure = (f: Floor, network = false) => merge(many(aliases), one(f, network))
  switch (sub) {
    case 'push': {
      const del = has('--delete', '-d') || rest.some((x) => /^:[^\s]/.test(x))
      return sure(del ? D('deletes something on the remote') : S(REMOTE), true)
    }
    case 'fetch':
    case 'pull':
    case 'clone':
    case 'ls-remote':
      return sure(S(REMOTE), true)
    case 'submodule':
      return has('update', 'add', 'init') ? sure(S(REMOTE), true) : many(aliases)
    case 'clean':
      return sure(D('deletes untracked files'))
    case 'rm':
      return sure(D('deletes files from the project'))
    case 'reset':
      return sure(has('--hard') ? D('throws away uncommitted changes') : C(PROJECT))
    case 'checkout':
      // `checkout -- path`, `checkout .` and `checkout -f` overwrite files in the working folder
      return sure(has('--', '.', '-f', '--force') ? D('throws away uncommitted changes') : C(PROJECT))
    case 'restore':
      return sure(has('--staged', '-S') && !has('--worktree', '-W') ? C(PROJECT) : D('throws away uncommitted changes'))
    case 'switch':
      return sure(has('--discard-changes', '-f', '--force') ? D('throws away uncommitted changes') : C(PROJECT))
    case 'branch':
      return sure(has('-D', '-d', '--delete') ? D('deletes a branch') : C(PROJECT))
    case 'tag':
      return sure(has('-d', '--delete') ? D('deletes a tag') : C(PROJECT))
    case 'stash':
      return sure(has('drop', 'clear') ? D('throws away stashed work') : C(PROJECT))
    case 'gc':
    case 'prune':
      return sure(D('deletes unreachable git data'))
    case 'add':
    case 'commit':
    case 'merge':
    case 'rebase':
    case 'apply':
    case 'am':
    case 'cherry-pick':
    case 'revert':
    case 'mv':
    case 'init':
    case 'worktree':
    case 'filter-branch':
    case 'config':
    case 'remote':
    case 'notes':
      return sure(C(PROJECT))
    default:
      return many(aliases)
  }
}

function packageRules(base: string, args: string[]): R {
  if (NPM_LIKE.has(base)) {
    const { word: sub } = firstOperand(args, NPM_VALUE_FLAGS)
    if (sub === undefined) return base === 'yarn' ? one(I('installs software')) : none()
    if (sub === 'publish') return one(S(REMOTE), true)
    if (base === 'npm' && sub === 'exec') return one(I('downloads and runs a package'), true)
    if (NPM_INSTALL.has(sub))
      return one(I(sub === 'dlx' || sub === 'x' ? 'downloads and runs a package' : 'installs software'), true)
    if (REMOVE_SUBS.has(sub)) return one(D('removes installed software'))
    return none()
  }
  const subs = Object.hasOwn(PKG_INSTALL, base) ? PKG_INSTALL[base] : undefined
  if (!subs) return none()
  const { word: sub } = firstOperand(args, new Set(['-C', '--directory']))
  const anyFlag = args.find((a) => subs.has(a))
  if (base === 'dotnet' && sub === 'add') return one(I('installs software'), true)
  if (sub !== undefined && REMOVE_SUBS.has(sub)) return one(D('removes installed software'))
  if (args.some((a) => /^-R/.test(a)) && base === 'pacman') return one(D('removes installed software'))
  if ((sub !== undefined && subs.has(sub)) || anyFlag !== undefined) return one(I('installs software'), true)
  if (PUBLISH_CMDS.has(base) && sub === 'publish') return one(S(REMOTE), true)
  return none()
}

function findRules(args: Word[], depth: number): R {
  const parts: R[] = []
  for (let j = 0; j < args.length; j++) {
    const t = (args[j] as Word).text
    if (t === '-delete') parts.push(one(D('deletes files')))
    else if (t === '-fprint' || t === '-fprintf' || t === '-fls' || t === '-fprint0')
      parts.push(one(C('writes to a file')))
    else if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      let e = j + 1
      while (e < args.length && (args[e] as Word).text !== ';' && (args[e] as Word).text !== '+') e++
      parts.push(commandOf(args.slice(j + 1, e), depth + 1, []))
      j = e
    }
  }
  return merge(none(), ...parts)
}

function shellRules(args: Word[], depth: number, bodies: string[]): R {
  let j = 0
  let script: Word | undefined
  while (j < args.length) {
    const t = (args[j] as Word).text
    if (t === '--') {
      j++
      break
    }
    if (!isFlag(t)) break
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
      script = args[j + 1]
      j += 2
      break
    }
    j += t === '-o' || t === '+o' || t === '-O' ? 2 : 1
  }
  if (script) {
    const inner = analyze(script.text, depth + 1)
    return many(script.dyn ? [BUILT, ...inner] : inner)
  }
  if (j < args.length) return one(CODE)
  // a shell with no script reads its commands from stdin: a pipe into it, a here-document or a here-string is its script
  const fromBodies = bodies.flatMap((b) => analyze(b, depth + 1))
  return { found: fromBodies, network: false, stdinCode: true }
}

// ---- programs that run code ---------------------------------------------------------------------------------------------------

const CODE_DELETE =
  /rmtree|remove_tree|os\.remove|os\.unlink|os\.rmdir|unlinkSync|rmSync|rmdirSync|fs\.rm\b|fs\.unlink|File\.delete|FileUtils\.rm|rm_rf|rm_r\b|\bunlink\b|Remove-Item/
const CODE_NET =
  /\b(urlopen|requests\.|urllib|fetch\(|http\.get|https\.get|XMLHttpRequest|socket\.|curl_exec|file_get_contents\(\s*['"]https?)/
/** Calls that hand a string to a shell (or start a program from it): the strings in the code are then read as commands. */
const SHELL_OUT =
  /os\.system|os\.popen|subprocess|popen|\bsystem\s*\(|\bexec\s*\(|execSync|execFileSync|spawnSync|spawn\s*\(|child_process|Open3|shell_exec|passthru|do shell script|`[^`]*`/
const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g

/** What inline code or a script's text does, as far as its strings and well-known calls show it. Always includes CODE. */
function codeRules(code: string, depth: number, shellIsOpaque = false): Found {
  const found: Found = [CODE]
  if (CODE_DELETE.test(code)) found.push(D('deletes files'))
  if (CODE_NET.test(code) || URL_RE.test(code)) found.push(S(REMOTE))
  if (SHELL_OUT.test(code)) {
    // the strings handed to the shell are commands: `os.system('rm -rf x')`, `subprocess.run(['rm', '-rf', 'x'])`
    for (const m of code.matchAll(STRING_LITERAL)) {
      const lit = (m[1] ?? m[2] ?? '').trim()
      if (lit.length >= 2) found.push(...analyze(lit, depth + 1))
    }
    // awk and AppleScript exist to run shell commands: what they build is not read
    if (shellIsOpaque) found.push(UNREAD('runs shell commands from inside a script'))
  }
  return found
}

function interpreterRules(name: string, args: Word[], depth: number, bodies: string[]): R {
  const shellIsOpaque = name === 'osascript'
  let j = 0
  let code: string | undefined
  while (j < args.length) {
    const t = (args[j] as Word).text
    if (!isFlag(t)) break
    const attached = /^--(?:eval|print)=(.*)$/s.exec(t)
    if (attached) {
      code = attached[1] as string
      j++
      break
    }
    if (INLINE_FLAGS.has(t) || /^-[A-Za-z]*[ce]$/.test(t)) {
      code = (args[j + 1] as Word | undefined)?.text ?? ''
      j += 2
      break
    }
    j++
  }
  if (code !== undefined) return many(codeRules(code, depth, shellIsOpaque))
  if (j < args.length) return one(CODE)
  // no code and no file: the program is read from stdin (a here-document, a here-string, or a pipe)
  return { found: bodies.flatMap((b) => codeRules(b, depth, shellIsOpaque)), network: false, stdinCode: true }
}

function pythonRules(args: Word[], depth: number, bodies: string[]): R {
  if (args[0]?.text === '-m') {
    const mod = args[1]?.text
    if (mod === 'pip' || mod === 'pip3')
      return commandOf(
        [{ text: 'pip', dyn: false, glob: false, brace: false, quoted: false }, ...args.slice(2)],
        depth + 1,
        [],
      )
    return one(CODE)
  }
  return interpreterRules('python', args, depth, bodies)
}

function redirectFloor(seg: Seg): Found {
  const out: Found = []
  for (const r of seg.redirs) {
    if (!(r.op.startsWith('>') || r.op === '&>') || !r.target) continue
    const t = r.target.text
    if (!r.target.dyn && /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(t)) continue
    out.push(C('writes to a file'))
  }
  return out
}

/** `su -c cmd`, `env -S 'cmd'`: the command is a string argument. */
function stringCommand(args: Word[], flags: readonly string[], depth: number): R | undefined {
  for (let j = 0; j < args.length - 1; j++) {
    if (!flags.includes((args[j] as Word).text)) continue
    const s = args[j + 1] as Word
    const inner = analyze(s.text, depth + 1)
    return many(s.dyn ? [BUILT, ...inner] : inner)
  }
  return undefined
}

function cloudRules(a: string[]): R {
  const destroy = a.some((x) => DESTROY_WORDS.has(x) || /^(delete|terminate|destroy)-/.test(x))
  return destroy ? one(D('deletes something on a remote service'), true) : one(S(REMOTE), true)
}

function rsyncRules(a: string[]): R {
  if (a.some((x) => x.startsWith('--del'))) return one(D('deletes files at the destination'))
  if (a.some((x) => x.startsWith('--remove-source')))
    return one(
      D('removes the files it copies from their source'),
      a.some((x) => /^[\w.@-]+:[^/]/.test(x)),
    )
  if (a.some((x) => !isFlag(x) && (/^rsync:\/\//.test(x) || /^[\w.@-]+:[^/]/.test(x) || /^[\w.-]+@[\w.-]+:/.test(x))))
    return one(S(REMOTE), true)
  return one(C('copies files'))
}

function commandOf(ws: Word[], depth: number, bodies: string[]): R {
  if (depth > MAX_DEPTH) return one(TOO_DEEP)
  let i = 0
  while (i < ws.length) {
    const t = (ws[i] as Word).text
    if ((RESERVED.has(t) && !(ws[i] as Word).dyn) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t)) i++
    else break
  }
  const head = ws[i]
  if (!head) return none()
  const base = baseOf(head.text)
  // the shell decides what runs: an expansion or a glob or a brace list in the command word
  if (/[$`]/.test(base) || base === '' || head.glob || head.brace) return one(BUILT)
  const args = ws.slice(i + 1)
  const a = args.map((x) => x.text)
  const has = (...f: string[]) => a.some((x) => f.includes(x))
  const urlRule = (): R => (a.some((x) => URL_RE.test(x)) ? one(S('reaches out to an internet address'), true) : none())

  if (base === 'env' && has('-S', '--split-string')) {
    const r = stringCommand(args, ['-S', '--split-string'], depth)
    if (r) return r
  }
  if (base === 'su') return stringCommand(args, ['-c', '--command'], depth) ?? none()
  if (Object.hasOwn(WRAPPERS, base)) {
    if (base === 'command' && has('-v', '-V')) return none()
    return commandOf(unwrap(base, args), depth + 1, bodies)
  }
  if (SHELLS.has(base)) return shellRules(args, depth, bodies)
  if (base === 'eval') {
    const inner = analyze(a.join(' '), depth + 1)
    return many(args.some((x) => x.dyn) ? [BUILT, ...inner] : inner)
  }
  if (base === 'source' || base === '.') return one(CODE)
  if (/^python[0-9.]*$/.test(base)) return pythonRules(args, depth, bodies)
  if (INTERPRETERS.has(base)) return interpreterRules(base, args, depth, bodies)
  if (base === 'find') return merge(findRules(args, depth), urlRule())
  if (DELETE_CMDS.has(base)) return one(D('deletes files'))
  if (base === 'git') return gitRules(a, depth)
  if (base === 'docker' || base === 'podman') {
    if (has('rm', 'rmi', 'prune')) return one(D('removes containers or images'))
    if (has('pull', 'push', 'login')) return one(S(REMOTE), true)
    return none()
  }
  if (base === 'rsync') return rsyncRules(a)
  if (base === 'sed') {
    return a.some((x) => /^-[A-Za-z]*i[A-Za-z.]*$/.test(x) || x.startsWith('--in-place'))
      ? one(C('changes files'))
      : none()
  }
  if (base === 'awk' || base === 'gawk' || base === 'mawk' || base === 'nawk') {
    if (a.some((x) => /\bsystem\s*\(|\|\s*getline|\|&/.test(x)))
      return many([
        UNREAD('runs commands from inside an awk program'),
        ...a.flatMap((x) => codeRules(x, depth, true).slice(1)),
      ])
    return has('inplace') ? one(C('changes files')) : none()
  }
  if (base === 'sort') return has('-o') || a.some((x) => x.startsWith('--output')) ? one(C('writes to a file')) : none()
  if (base === 'tee') return a.some((x) => !isFlag(x) && x !== '/dev/null') ? one(C('writes to a file')) : none()
  if (base === 'crontab')
    return has('-r') ? one(D('removes the crontab')) : has('-l') ? none() : one(C('changes the crontab'))
  if (base === 'tar')
    return /[cxru]/.test(a.find((x) => /^-?[A-Za-z]+$/.test(x) && !x.startsWith('--')) ?? '') ||
      has('--extract', '--create', '--append', '--update')
      ? one(C('changes files'))
      : none()
  if (['gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz'].includes(base))
    return has('-c', '-t', '-l', '--stdout', '--test', '--list') ? none() : one(C('changes files'))
  if (base === 'defaults') {
    const sub = firstOperand(a).word
    return sub === 'delete'
      ? one(D('deletes a setting'))
      : sub === 'write' || sub === 'import' || sub === 'rename'
        ? one(C('changes files'))
        : none()
  }
  if (base === 'launchctl')
    return has(
      'load',
      'unload',
      'bootstrap',
      'bootout',
      'start',
      'stop',
      'kickstart',
      'enable',
      'disable',
      'remove',
      'submit',
    )
      ? one(C('changes system services'))
      : none()
  if (base === 'diskutil')
    return has('eraseDisk', 'eraseVolume', 'erase', 'partitionDisk', 'reformat', 'secureErase', 'zeroDisk')
      ? one(D('erases a disk'))
      : none()
  if (/^(mkfs|newfs)/.test(base)) return one(D('erases a disk'))
  if (base === 'npx' || base === 'bunx' || base === 'pnpx' || base === 'uvx')
    return one(I('downloads and runs a package'), true)
  if (NPM_LIKE.has(base) || Object.hasOwn(PKG_INSTALL, base)) {
    const r = packageRules(base, a)
    return r.found.length > 0 ? r : urlRule()
  }
  if (CHANGE_CMDS.has(base)) return merge(one(C('changes files')), TEXT_CMDS.has(base) ? none() : urlRule())
  if (CLOUD_CMDS.has(base)) return cloudRules(a)
  if (SEND_CMDS.has(base)) return one(S(REMOTE), FETCHERS.has(base))
  if (TEXT_CMDS.has(base)) return none()
  return urlRule()
}

function analyzeSeg(seg: Seg, depth: number): R {
  const r = commandOf(seg.words, depth, seg.bodies)
  return { ...r, found: [...r.found, ...redirectFloor(seg)] }
}

/** A scan for the commands that matter in text the lexer could not cut (an unterminated quote). Over-matches on purpose. */
function coarse(src: string): Found {
  const out: Found = []
  // a command word follows a space, an operator, a bracket or a quote (a truncated JSON preview has `"rm -rf ...`)
  const cmd = (names: string) => new RegExp(`(?:^|[\\s;&|(\`$"'])(?:${names})(?:\\s|$|["'])`)
  if (
    cmd('rm|rmdir|unlink|shred|srm').test(src) ||
    /\bgit\s+clean\b/.test(src) ||
    /\bfind\b[^\n]*\s-delete\b/.test(src)
  )
    out.push(D('deletes files'))
  if (
    cmd('curl|wget|scp|ssh|nc|ncat|netcat|rsync|sftp|ftp|telnet').test(src) ||
    /\bgit\s+(push|fetch|pull|clone)\b/.test(src) ||
    URL_RE.test(src)
  )
    out.push(S(REMOTE))
  if (/\b(npm|pnpm|yarn|bun|pip3?|brew|cargo|gem|uv)\s+(install|add|i)\b/.test(src)) out.push(I('installs software'))
  if (/\b(curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(src))
    out.push(I('downloads a script and runs it'))
  if (cmd('mv|cp|touch|mkdir|tee|chmod|chown|ln').test(src) || /\bsed\s+-[A-Za-z]*i/.test(src))
    out.push(C('changes files'))
  return out
}

function analyze(src: string, depth: number): Found {
  if (depth > MAX_DEPTH) return [TOO_DEEP]
  const nested: Found = []
  const segs = lex(src, (inner) => nested.push(...analyze(inner, depth + 1)))
  if (!segs) return [...nested, ...coarse(src)]
  const out: Found = [...nested]
  let pipeFetch = false
  for (const seg of segs) {
    if (!seg.piped) pipeFetch = false
    const r = analyzeSeg(seg, depth)
    out.push(...r.found)
    if (r.network) pipeFetch = true
    if (seg.piped && r.stdinCode)
      out.push(pipeFetch ? I('downloads a script and runs it') : C('runs commands piped into a shell'))
  }
  return out
}

/**
 * The command in a Bash call's input: its `command` field when the input is JSON. Input that is not JSON is the command itself;
 * when it looks like a cut-off JSON preview (`{"command": ...`) the raw text is scanned coarsely as well, because the lexer would
 * read its quotes as one long word.
 */
function bashCommand(input: string): { cmd: string; alsoCoarse?: true } | null {
  const t = input.trimStart()
  if (t.startsWith('{')) {
    try {
      const v = JSON.parse(input) as unknown
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const c = (v as Record<string, unknown>).command
        return typeof c === 'string' ? { cmd: c } : null
      }
    } catch {
      // not JSON: a brace group, or a cut-off preview
    }
    if (t.startsWith('{"')) return { cmd: input, alsoCoarse: true }
  }
  return { cmd: input }
}

/**
 * The least severe tag the call can honestly wear, with a clause that is true of it; null when no rule applies. `tool` is the
 * Claude Code tool name, `input` the call as the card has it (a Bash command, or the tool's input as JSON). `unreadable` is true
 * when any part of the call is one Talos cannot read; `opaque` when the finding that sets the tag is itself that.
 */
export type CallFloor = Floor & { unreadable?: true }

export function permissionFloor(tool: string, input: string): CallFloor | null {
  let found: Found = []
  if (tool === 'Bash') {
    const b = bashCommand(input)
    if (b === null) found = []
    else if (b.cmd.length > MAX_CHARS) found = [UNREAD('is too long for Talos to read')]
    else found = [...analyze(b.cmd, 0), ...(b.alsoCoarse ? coarse(b.cmd) : [])]
  } else if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit')
    found = [C('writes to files')]
  else if (tool === 'WebFetch' || tool === 'WebSearch') found = [S(REMOTE)]
  let best: Floor | null = null
  for (const f of found)
    if (best === null || rank(f.tag) > rank(best.tag) || (rank(f.tag) === rank(best.tag) && !f.opaque && best.opaque))
      best = f
  if (best === null) return null
  return { ...best, ...(found.some((f) => f.opaque) ? { unreadable: true as const } : {}) }
}
