// Guard: no owner-facing text tells the owner to open Terminals, run `tmux attach`, ssh somewhere or run `claude /login`
// (scripts/pane-strings.ts has the rule and its reasons). The allowlist below is the whole list of exceptions: developer text, screen text that is only
// matched and never shown, and strings not yet converted, each naming the row of the pane-prompts plan that removes it (round 2 converted
// rows 5 and 6, the sign-in ones; round 3 rows 2, 3 and 4: the MCP server approval, the development-channels question and the bypass
// disclaimer; round 4 rows 8 and 9 on the Mac: the tool permission and the agent's own question). An entry that matches nothing fails the test, so a converted string must leave the list.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Allowed, judge, scan } from './pane-strings.ts'
import { ROOT } from './size-report.ts'

const SCREEN = 'screen text Claude Code draws, matched and never shown to the owner'
const SWIFT_NOTICE = 'apps/desktop/Sources/TalosDesktopCore/SupervisorNotice.swift'
const SESSION_SWITCHER = 'apps/desktop/Sources/TalosDesktopCore/SessionSwitcher.swift'
const WORKER_NOTICES = 'apps/bridge/src/supervisor/worker-notices.ts'

const ALLOWED: Allowed[] = [
  // screen text that is only matched
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/DialogMatcher.swift',
    line: 'public static let login = [',
    why: SCREEN,
    row: 'detect',
  },
  { file: 'apps/desktop/Sources/TalosDesktopCore/BoxFrame.swift', line: '"Run /login"', why: SCREEN, row: 'detect' },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/FirstStartScreens.swift',
    line: 'Run /login")',
    why: SCREEN,
    row: 'detect',
  },
  { file: 'apps/bridge/src/supervisor/screen.ts', line: "login: ['Please run /login'", why: SCREEN, row: 'detect' },
  { file: 'apps/bridge/src/supervisor/box-frame.ts', line: "'Run /login',", why: SCREEN, row: 'detect' },
  // developer text: the owner-typed talos-app command gate (on purpose) and the developer's attach command
  {
    file: 'apps/bridge/src/cli-main.ts',
    line: 'only runs in Terminal, typed by you',
    why: 'the gate is the point: this command must be typed by the owner, never an agent',
    row: 'advanced',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktop/TerminalWindow.swift',
    line: 'our own `tmux attach` child',
    why: 'a code remark on the same line as code, not text shown',
    row: 'advanced',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/MacWords.swift',
    line: 'public static let copyAttachCommand = "Copy tmux attach command"',
    why: 'a developer menu item, now only in the Advanced submenu and the Advanced tab',
    row: 'advanced',
  },
  // not a pane prompt: installing tmux with Homebrew
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/OnboardingText.swift',
    line: 'Open Terminal and run: brew install tmux',
    why: 'the Homebrew install of tmux is not a Claude Code prompt',
    row: 'out of scope (prerequisite install)',
  },
  // rows not converted yet
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/OnboardingText.swift',
    line: 'Claude has not finished starting. Open Terminals',
    why: 'start stalled',
    row: '12',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/OnboardingText.swift',
    line: 'only you can answer (a folder trust). Open Terminals',
    why: 'the setup screen line for the folder-trust question',
    row: '1',
  },
  { file: SESSION_SWITCHER, line: 'Open this thread in Terminals to clear it', why: 'left-over line', row: '12' },
  {
    file: SESSION_SWITCHER,
    line: "Open this thread in Terminals to see what it's waiting on",
    why: 'no input box',
    row: '12',
  },
  {
    file: SESSION_SWITCHER,
    line: 'Open this thread in Terminals to finish or clear it',
    why: 'unsent text',
    row: '12',
  },
  {
    file: SESSION_SWITCHER,
    line: 'Open this thread in Terminals',
    why: 'refused / unseen / scrolled back lines',
    row: '12',
  },
  {
    file: SESSION_SWITCHER,
    line: 'open this thread in Terminals on the Mac to answer',
    why: 'the default dialog line',
    row: '1, 11',
  },
  {
    file: WORKER_NOTICES,
    line: 'attach on ${w.machine}',
    why: 'Linux thread lines name the tmux session (the Mac side of rows 8 and 9 is converted; Linux is not)',
    row: '1, 8 and 9 on Linux, 11, 12',
  },
  {
    file: WORKER_NOTICES,
    line: 'Attach on ${w.machine}',
    why: 'Linux thread lines name the tmux session',
    row: '8 and 9 on Linux, 11, 12',
  },
]

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('no owner-facing text sends the owner to a terminal', () => {
  const hits = scan(ROOT)
  const { uncovered, stale } = judge(hits, ALLOWED)

  it('every instruction in the tree is on the allowlist, with a row', () => {
    expect(uncovered.map((h) => `${h.file}:${h.line} [${h.id}] ${h.text.slice(0, 120)}`)).toEqual([])
    for (const a of ALLOWED) expect(a.row.length).toBeGreaterThan(0)
  })

  it('every allowlist entry still matches a line (a converted string leaves the list)', () => {
    expect(stale.map((a) => `${a.file}: ${a.line}`)).toEqual([])
  })

  it('the sign-in strings this round converted are not on the list', () => {
    for (const a of ALLOWED) {
      expect(a.line).not.toMatch(/auth login|type \/login|claude \/login|ssh to/i)
      expect(a.why).not.toMatch(/sign-in text/i)
    }
    expect(
      hits.filter(
        (h) =>
          h.id === 'ssh' ||
          (h.id === 'run-login' && !ALLOWED.some((a) => a.row === 'detect' && h.text.includes(a.line))),
      ),
    ).toEqual([])
  })

  it('rows 2, 3 and 4 (MCP server, development channel, bypass disclaimer) are converted: no entry waits on them', () => {
    for (const a of ALLOWED) expect(a.row, `${a.file}: ${a.line}`).not.toMatch(/(?:^|[^\d])[234](?:[^\d]|$)/)
    // and none of those prompts' words is on the list: a new "open Terminals" about them would fail the scan above
    for (const a of ALLOWED)
      expect(`${a.line} ${a.why}`, a.file).not.toMatch(/MCP|bypass|development.channel|dev.channel/i)
  })

  it('rows 8 and 9 (tool permission, the agent question) are converted on the Mac: no Mac entry waits on them', () => {
    for (const a of ALLOWED.filter((x) => x.file.startsWith('apps/desktop/')))
      expect(a.row, `${a.file}: ${a.line}`).not.toMatch(/(?:^|[^\d])[89](?:[^\d]|$)/)
    for (const a of ALLOWED.filter((x) => x.file.startsWith('apps/desktop/')))
      expect(`${a.line} ${a.why}`, a.file).not.toMatch(
        /tool permission|Bash command|AskUserQuestion|agent.s own question/i,
      )
  })

  it('a planted string fails the scan, in each of the three trees', () => {
    const root = mkdtempSync(join(tmpdir(), 'talos-pane-strings-'))
    dirs.push(root)
    const plant = (rel: string, body: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    plant('apps/desktop/Sources/X/A.swift', 'let t = "Open Terminals… to answer it"\n')
    plant('apps/bridge/src/b.ts', 'export const t = `ssh to ${machine} and run claude /login`\n')
    plant('apps/web/src/c.tsx', 'export const t = <p>Run tmux attach -t talos</p>\n')
    const found = scan(root)
    const bad = judge(found, ALLOWED).uncovered
    expect(bad.map((h) => h.file).sort()).toEqual([
      'apps/bridge/src/b.ts',
      'apps/bridge/src/b.ts',
      'apps/desktop/Sources/X/A.swift',
      'apps/web/src/c.tsx',
    ])
    // control: a clean tree and a comment-only mention pass
    const clean = mkdtempSync(join(tmpdir(), 'talos-pane-strings-'))
    dirs.push(clean)
    mkdirSync(join(clean, 'apps/bridge/src'), { recursive: true })
    writeFileSync(
      join(clean, 'apps/bridge/src/ok.ts'),
      '// never say "tmux attach" to the owner\nexport const t = "Sign in to Claude again"\n',
    )
    expect(scan(clean)).toEqual([])
  })

  it('an allowlist entry for another file does not cover a planted copy of the same words', () => {
    const planted = [
      {
        file: 'apps/bridge/src/other.ts',
        line: 'attach on ${w.machine}',
        id: 'attach-on',
        text: 'x attach on ${w.machine}',
      },
    ]
    expect(judge(planted, ALLOWED).uncovered).toHaveLength(1)
  })
})
