// The owner's computer in every sentence that names it (owner-words.ts, Pantheon's no-Mac-words pass): the Mac's sentences are
// unchanged (the rest of the suite pins them, with the tests' computer pinned to the Mac in preload.ts); no Linux or Windows
// sentence says "Mac"; a Windows sentence never gives a command to run; and the sentences really follow the computer.
import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Host } from '@talos-app/protocol'
import ts from 'typescript'
import { appsFix, machineName, say, WINDOWS_OPEN_SESSION, WINDOWS_SIGN_IN } from '../src/owner-words.ts'
import { OWNER_HOST_TEST } from '../src/platform.ts'
import { ChronosAdapter, headlessOffMac } from '../src/schedules/chronos-adapter.ts'
import { NO_SCHEDULER_TEXT, noSchedulerText } from '../src/schedules/closed-adapter.ts'
import { usageLimitThreadLine } from '../src/supervisor/usage-limit.ts'
import { lines, type Where } from '../src/supervisor/worker-notices.ts'
import { restartMain } from '../src/tools/restart-main.ts'
import { schedulesList } from '../src/tools/schedules.ts'
import { threadSession } from '../src/tools/sessions.ts'

const as = (host: Host) => {
  OWNER_HOST_TEST.host = host
}
afterEach(() => {
  OWNER_HOST_TEST.host = 'mac' // as preload.ts left it
})

describe('say and the machine’s name', () => {
  test('the Mac’s sentence on a Mac, Linux’s on Linux, the Windows PC’s or else Linux’s on the Windows PC', () => {
    const w = { mac: 'M', linux: 'L', windows: 'W' }
    expect([say(w, 'mac'), say(w, 'linux'), say(w, 'windows')]).toEqual(['M', 'L', 'W'])
    expect(say({ mac: 'M', linux: 'L' }, 'windows')).toBe('L')
    // the Windows PC is "your PC" / "this PC" (Pantheon), in its own sentence and in the Linux one it falls back to
    const computer = { mac: 'on your Mac', linux: "Your computer and this computer's clock, at the owner's computer" }
    expect(say(computer, 'windows')).toBe("Your PC and this PC's clock, at the owner's PC")
    expect(say({ ...computer, windows: 'On the PC, your computer' }, 'windows')).toBe('On the PC, your PC')
    expect(say(computer, 'linux')).toBe(computer.linux)
    expect(say(w)).toBe('M') // the tests' computer
    as('windows')
    expect(say(w)).toBe('W')
  })
  test('one line of printable text, at most 40 characters, "this computer" when nothing is left', () => {
    expect(machineName('box')).toBe('box')
    expect(machineName('evil\u001b]0;title\u0007host\nname')).toBe('evil ]0;title host name')
    expect(machineName('​\t \n')).toBe('this computer')
    expect(machineName('')).toBe('this computer')
    expect([...machineName('x'.repeat(60))].length).toBe(40)
  })
  test('the Windows PC’s sentences, byte for byte (one constant for opening a session: Titan’s tray item, Open a thread’s session...)', () => {
    expect(WINDOWS_OPEN_SESSION).toBe(
      "On the PC, click the Talos icon by the clock, choose Open a thread's session..., and pick this thread.",
    )
    expect(WINDOWS_SIGN_IN).toBe('On the PC, click the Talos icon by the clock and choose Sign in to Claude…')
    expect(appsFix('scan', '.')).toBe('Run talos-app apps scan on the Mac.')
    as('linux')
    expect(appsFix('scan', ' to re-approve.')).toBe('Run talos-app apps scan on this computer to re-approve.')
    as('windows')
    expect(appsFix()).toBe("MCP apps can't be set up on a Windows PC yet.")
  })
})

/** Every string given as a `linux:` or `windows:` sentence in the bridge's sources, with where it is. */
function sentences(root: string): Array<{ at: string; host: 'linux' | 'windows'; text: string }> {
  const out: Array<{ at: string; host: 'linux' | 'windows'; text: string }> = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8')
        if (!src.includes('owner-words.ts') && !n.startsWith('owner-words')) continue
        const re = /\b(linux|windows):\s*/g
        for (let m = re.exec(src); m; m = re.exec(src)) {
          const q = src[re.lastIndex]
          if (q !== "'" && q !== '"' && q !== '`') continue
          let i = re.lastIndex + 1
          let text = ''
          while (i < src.length && src[i] !== q) {
            if (src[i] === '\\') {
              text += src[i + 1]
              i += 2
            } else text += src[i++]
          }
          out.push({
            at: `${p.slice(root.length + 1)}:${src.slice(0, re.lastIndex).split('\n').length}`,
            host: m[1] as 'linux',
            text,
          })
        }
      }
    }
  }
  walk(root)
  return out
}

describe('no Linux or Windows sentence says "Mac"; no Windows sentence gives a command to run', () => {
  const all = sentences(join(import.meta.dir, '..', 'src'))
  test('the sweep finds the pass’s sentences', () => {
    expect(all.length).toBeGreaterThanOrEqual(50)
    expect(all.some((s) => s.host === 'windows')).toBe(true)
  })
  test('none says Mac', () => {
    for (const s of all) expect(s.text, s.at).not.toMatch(/\bMac\b|macOS|System Settings/)
  })
  test('a Windows sentence names no command to run there (the PC has no terminal): the tray, or "can’t … yet"', () => {
    for (const s of all.filter((x) => x.host === 'windows'))
      expect(s.text, s.at).not.toMatch(/\bRun talos-app|run `|\bssh\b|Open a terminal|attach/)
  })
})

/** Files whose every sentence is about a Mac-only part of Talos: the screen tools, Chronos (launchd), restart-main's Mac words. */
const MAC_ONLY_FILES = new Set([
  'restart-main.ts',
  'screen.ts',
  'screen-consent.ts',
  'tools/screen.ts',
  'apps/keychain.ts', // the macOS Keychain
])
/** What a non-Mac sentence must not say (Fable: macOS and System Settings too, not only "Mac"). */
const MAC_WORDS = /\bMac\b|\bmacOS\b|System Settings/

/** Single sentences that are about the Mac wherever they are said (or are logs, or the Mac's own constant a say() uses). */
const MAC_ONLY_TEXT = [
  'At the Mac run `talos-app schedules adopt`', // Chronos-only
  'screen_ask needs the id the Mac gave', // the screen tools
  "isn't on this Mac's allowed list", // the screen tools
  'device awaiting the Mac confirmation', // a log line
  'media.fetch: not on this Mac', // a log line
  'sign it on a Mac first', // iOS Shortcuts are signed on a Mac
  'native iPhone changes', // built with Xcode, on a Mac
  'is passed between the Mac and the bridge', // the Mac app's dialog file
  'the Mac app runs it at each start of Main', // guards refresh is the Mac app's
  '3. Mac app: run', // printed only on a Mac
  'The Mac app re-pins it', // and says what to do without it
  'No scheduler is installed on this Mac. Tell the owner', // NO_SCHEDULER_TEXT, the Mac's branch of noSchedulerText()
  'macOS or Linux (or a WSL distro you set up yourself): bun upgrade', // bun-floor.ts: names each platform, one line each
  'the Mac may be busy', // a scheduler that does not answer is Chronos
  'Your Mac is already making audio', // BUSY_MESSAGE, the Mac's branch
  'Your Mac has no voice set up yet', // NO_TTS_MESSAGE, the Mac's branch
  'It needs macOS 12+ with an iCloud sign-in', // iOS Shortcuts are signed on a Mac
  'This machine is not macOS, so it was not signed here', // and say so off one
  'macOS may be waiting for permission', // a Chronos (launchd) run's status
]

/**
 * Every string or template piece in the bridge's sources that says "Mac" and is not a say() `mac:` branch, by TypeScript's own
 * parser (comments, regexes and nested templates read right). A piece inside a `mac:` property, at any depth, is the Mac's.
 */
function strayMacText(root: string): string[] {
  const out: string[] = []
  const inMacBranch = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isPropertyAssignment(p)) return ts.isIdentifier(p.name) && p.name.text === 'mac'
      if (ts.isCallExpression(p) || ts.isBlock(p) || ts.isSourceFile(p)) return false
    }
    return false
  }
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      const rel = p.slice(root.length + 1)
      if (!n.endsWith('.ts') || MAC_ONLY_FILES.has(rel)) continue
      const sf = ts.createSourceFile(rel, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node) => {
        const text =
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
            ? node.text
            : null
        if (text !== null && MAC_WORDS.test(text) && !inMacBranch(node) && !MAC_ONLY_TEXT.some((t) => text.includes(t)))
          out.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${text.slice(0, 90)}`)
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
  }
  walk(root)
  return out
}

describe('every sentence in the bridge that says "Mac" is the Mac’s own (Fable: a sweep of every literal, not only linux: and windows:)', () => {
  test('each is a say() mac: branch, in a Mac-only file, or a named Mac-only sentence', () => {
    expect(strayMacText(join(import.meta.dir, '..', 'src'))).toEqual([])
  })
})

describe('the thread notices on the Windows PC', () => {
  const linuxWhere: Where = {
    attach: 'talos-app supervise attach trip',
    restart: 'talos-app supervise restart-thread trip',
    machine: 'box',
  }
  const winWhere: Where = { ...linuxWhere, windows: true }
  const said = (w: Where) => [
    lines.dialog('trust', w),
    lines.login(w),
    lines.prompt({ kind: 'tool', title: 'Run a command?' } as never, w),
    lines.draft(w),
    lines.noBox(w),
    lines.leftover(w),
    lines.turnCut('restart', w),
    lines.refused(w),
    lines.enterUncertain(w),
    lines.unseen(w),
    lines.copyMode(w),
    lines.hookMissing('the hook is gone', 'trip', w),
    lines.needsMac('folder trust', w),
  ]
  test('Linux keeps its commands; the Windows PC gets none, and the gap-1 sentence where Linux attaches', () => {
    for (const l of said(linuxWhere)) expect(l).toMatch(/talos-app supervise|claude \/login/)
    const win = said(winWhere)
    for (const l of win) {
      expect(l).not.toMatch(/talos-app|ssh|attach on|Mac\b/)
      expect(l.startsWith('This thread') || l.startsWith('Talos')).toBe(true) // the line's own first sentence is kept
    }
    expect(win.filter((l) => l.endsWith(WINDOWS_OPEN_SESSION)).length).toBe(11)
    expect(lines.login(winWhere)).toContain(WINDOWS_SIGN_IN)
  })
  test('the usage-limit line points at the pane only where it can be opened', () => {
    const info = { kind: 'menu', resetsAt: null } as never
    expect(usageLimitThreadLine(info, 'talos-app supervise attach trip')).toContain('talos-app supervise attach trip')
    const win = usageLimitThreadLine(info, 'talos-app supervise attach trip', true)
    expect(win).not.toContain('talos-app')
    expect(win).toContain("Open a thread's session...")
  })
})

describe('the sentences follow the computer', () => {
  test('apply refuses a background job off a Mac on its own, before Chronos is asked (Fable: never trust validate ran)', async () => {
    as('linux')
    // a Chronos that is not there: asking it would throw, so the answer must come before any spawn
    const a = new ChronosAdapter({
      bin: '/nonexistent/chronos',
      config: '/nonexistent/config.json',
      timeoutMs: 1000,
    } as never)
    const r = await a.apply({ op: 'create', draft: { runner: 'headless', permissions: 'full' } } as never, null)
    expect(r).toMatchObject({ ok: false, code: 'schedule_invalid' })
    expect(r.ok ? '' : r.message).toContain('Talos thread')
  })
  test('off a Mac a job may only run in a Talos thread: a background job is refused in words before Chronos is asked', () => {
    const draft = (runner: 'session' | 'headless') => ({ op: 'create', draft: { runner } }) as never
    expect(headlessOffMac(draft('headless'), 'mac')).toBeNull() // a Mac has its timer
    expect(headlessOffMac(draft('session'), 'linux')).toBeNull()
    expect(headlessOffMac(draft('headless'), 'linux')).toBe(
      "This job would run by itself in the background, which needs the scheduler's background timer, and it isn't running on this computer. Reinstall Chronos (its installer starts the timer), or set the job to run in a Talos thread instead.",
    )
    expect(headlessOffMac(draft('headless'), 'windows')).toContain("isn't running on this PC")
    // the timer beating (Chronos's tick on Linux): a background job is fine there, judged by the beat, never the platform
    expect(headlessOffMac(draft('headless'), 'linux', true)).toBeNull()
    expect(
      headlessOffMac({ op: 'update', id: 'x', base_etag: 'e', set: { runner: 'headless' } } as never, 'linux'),
    ).not.toBeNull()
    expect(headlessOffMac({ op: 'update', id: 'x', base_etag: 'e', set: { name: 'n' } } as never, 'linux')).toBeNull()
    expect(headlessOffMac({ op: 'delete', id: 'x', base_etag: 'e' } as never, 'linux')).toBeNull()
    // a job limited to the tools it lists always runs in the background (Chronos never offers it to a session): refused too
    const restricted = { op: 'create', draft: { runner: 'session', permissions: 'restricted' } } as never
    // the fix for a restricted job is its permissions, so the words name them (Fable)
    expect(headlessOffMac(restricted, 'linux')).toBe(
      "A job limited to the tools it lists can't run on this computer yet. Give it full permissions: it then runs by itself, unattended, or in a Talos thread.",
    )
    expect(headlessOffMac(restricted, 'linux', true)).not.toBeNull() // the timer is no help to it: the root runtime is later
    expect(headlessOffMac(restricted, 'mac')).toBeNull()
    expect(
      headlessOffMac({ op: 'update', id: 'x', base_etag: 'e', set: { permissions: 'restricted' } } as never, 'windows'),
    ).not.toBeNull()
    expect(
      headlessOffMac({ op: 'create', draft: { runner: 'session', permissions: 'full' } } as never, 'linux'),
    ).toBeNull()
  })
  test('the tools’ texts are read when asked, so they follow the computer in force (Fable)', () => {
    expect(restartMain.description).toContain('the Mac app')
    as('linux')
    expect(restartMain.description).toContain('the supervisor on this computer')
    expect(restartMain.instructions).not.toMatch(/\bMac\b/)
    expect(threadSession.description).not.toMatch(/\bMac\b/)
    expect(schedulesList.description).toContain('this computer')
  })
  test('no scheduler: off a Mac Chronos can be installed (Linux) or Setup installs it (the Windows PC); the Mac’s unchanged', () => {
    expect(noSchedulerText()).toBe(NO_SCHEDULER_TEXT)
    as('linux')
    expect(noSchedulerText()).toStartWith(
      'No scheduler is installed on this computer. Tell the owner they can install Chronos',
    )
    as('windows')
    expect(noSchedulerText()).toStartWith(
      'No scheduler is installed on this PC. Tell the owner to run Talos Setup again',
    )
  })
})
