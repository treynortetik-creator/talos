// Guard: no owner-facing text tells the owner to open Terminals, run `tmux attach`, ssh somewhere or run `claude /login`
// (scripts/pane-strings.ts has the rule and its reasons). The allowlist below is the whole list of exceptions: developer text, screen text that is only
// matched and never shown, and strings not yet converted, each naming the row of the pane-prompts plan that removes it (round 2 converted
// rows 5 and 6, the sign-in ones; round 3 rows 2, 3 and 4: the MCP server approval, the development-channels question and the bypass
// disclaimer; round 4 rows 8 and 9 on the Mac: the tool permission and the agent's own question). An entry that matches nothing fails the test, so a converted string must leave the list.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Allowed, judge, scan } from './pane-strings.ts'
import { ROOT } from './size-report.ts'

const SCREEN = 'screen text Claude Code draws, matched and never shown to the owner'
const SWIFT_NOTICE = 'apps/desktop/Sources/TalosDesktopCore/SupervisorNotice.swift'
const SESSION_SWITCHER = 'apps/desktop/Sources/TalosDesktopCore/SessionSwitcher.swift'
const WORKER_NOTICES = 'apps/bridge/src/supervisor/worker-notices.ts'
const LINUX_USAGE_LIMIT = 'apps/bridge/src/supervisor/usage-limit.ts'

const ALLOWED: Allowed[] = [
  // the owner asked for this one: the [Open terminal] button on the quiet notice opens the agent's terminal in the Mac app
  {
    file: 'apps/web/src/features/threads/messageActionWords.ts',
    line: "open_terminal: 'Open terminal'",
    why: 'owner 11/26 06:47 asked for an Open terminal button',
    row: 'owner asked for it',
  },
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
  // developer commands the owner types in the Mac's Terminal app (talos-app enroll, install-guards, doctor), the Run in Terminal button, and the
  // Advanced menu: no Claude Code prompt is answered there
  {
    file: 'apps/desktop/Sources/TalosDesktop/AgentFolderPanel.swift',
    line: 'run this in Terminal without --dry-run',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktop/SignIn.swift',
    line: 'Or run it yourself in Terminal:',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/AgentFolderSetup.swift',
    line: 'or run ./install.sh in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/AgentFolderSetup.swift',
    line: 'Rebuild it from your own clone: in Terminal, ',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/GuardsRefresh.swift',
    line: 'If this keeps happening, run talos-app install-guards in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/GuardsRefresh.swift',
    line: 'if this stays, run talos-app install-guards in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/MacWords.swift',
    line: 'public static let forbidden = ["relay"',
    why: 'the list of words the words guard forbids, matched and never shown',
    row: 'detect',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/MainRestartCheck.swift',
    line: "press Esc in Main's pane; Esc is the only key to press there",
    why: 'the restart-stall line for a dialog Talos does not name',
    row: '11, 12',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/SessionSwitcher.swift',
    line: "press Esc in this thread's pane in Terminals; Esc is the only key to press there",
    why: 'the computer-use permissions line',
    row: '10',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/SignInHelp.swift',
    line: 'Run it in Terminal. It prints a one-time link',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/SignInHelp.swift',
    line: 'type y in Terminal if they match',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/card-cli.ts',
    line: 'Run it in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/doctor-mods.ts',
    line: 'Run `claude plugin list` in Terminal',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/doctor-mods.ts',
    line: 'run `claude doctor` in Terminal',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/guards/refresh.ts',
    line: 'run talos-app install-guards in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/guards/refresh.ts',
    line: 'Run talos-app install-guards again in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/guards/refresh.ts',
    line: 'run talos-app install-guards from it in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/guards/rules.ts',
    line: 'Only the owner runs those, in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/guards/rules.ts',
    line: 'Ask the owner to run it in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/tripwire.ts',
    line: 'run talos-app devices in Terminal',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/bridge/src/pane-run.ts',
    line: 'cannot run a script in the pane',
    why: 'the Run in Terminal feature (a script the owner chose to run), not a prompt',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/features/auth/EnrollPage.tsx',
    line: 'run <code>talos-app enroll</code> in Terminal, copy the link',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/web/src/features/auth/EnrollPage.tsx',
    line: 'run <code>talos-app enroll</code> in Terminal; on a',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/web/src/features/help/content.ts',
    line: 'Run it in Terminal, paste the link it prints',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/web/src/features/help/content.ts',
    line: 'run {{talos-app enroll}} in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/web/src/features/help/content.ts',
    line: 'and answer the dialog in the pane yourself.',
    why: 'Help for the Advanced menu item Show my agent’s screen',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/features/help/content.ts',
    line: 'your agent is still running in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/web/src/features/help/content.ts',
    line: 'Run {{talos-app doctor}} in Terminal.',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  {
    file: 'apps/web/src/features/threads/RunButton.tsx',
    line: 'Run in Terminal needs it.',
    why: 'the Run in Terminal button is a product feature, not a prompt',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/features/threads/RunButton.tsx',
    line: "'Ran in Terminal'",
    why: 'the Run in Terminal button',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/features/threads/RunButton.tsx',
    line: "Didn't run in Terminal",
    why: 'the Run in Terminal button',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/features/threads/RunButton.tsx',
    line: 'No answer from Terminal; see the thread.',
    why: 'the Run in Terminal button',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/features/threads/RunButton.tsx',
    line: "'Run in Terminal'",
    why: 'the Run in Terminal button',
    row: 'advanced',
  },
  {
    file: 'apps/web/src/lib/hostWords.ts',
    line: 'run talos-app enroll in Terminal; on a Windows PC',
    why: 'a developer command typed in the Mac Terminal app, not a Claude Code prompt',
    row: 'cli',
  },
  { file: SWIFT_NOTICE, line: 'press Esc there to close it', why: 'the computer-use line for Main', row: '10' },
  // rows not converted yet
  {
    file: LINUX_USAGE_LIMIT,
    line: 'To go on now, press Esc in ${pane}',
    why: "the Linux supervisor's usage-limit line: the card is Mac-only so far (FOLLOWUPS)",
    row: '7 on Linux',
  },
  {
    file: LINUX_USAGE_LIMIT,
    line: 'Another model will not help with this one: press Esc in ${pane}',
    why: "the Linux supervisor's usage-limit line: the card is Mac-only so far (FOLLOWUPS)",
    row: '7 on Linux',
  },
  {
    file: LINUX_USAGE_LIMIT,
    line: 'Press Esc in ${pane} to close the menu; more needs your admin.',
    why: "the Linux supervisor's usage-limit line: the card is Mac-only so far (FOLLOWUPS)",
    row: '7 on Linux',
  },
  {
    file: LINUX_USAGE_LIMIT,
    line: 'Press Esc in ${pane} to close the menu; changing the spend limit',
    why: "the Linux supervisor's usage-limit line: the card is Mac-only so far (FOLLOWUPS)",
    row: '7 on Linux',
  },
  {
    file: LINUX_USAGE_LIMIT,
    line: 'Press Esc in ${pane} to close the menu; going on needs a plan.',
    why: "the Linux supervisor's usage-limit line: the card is Mac-only so far (FOLLOWUPS)",
    row: '7 on Linux',
  },
  {
    file: LINUX_USAGE_LIMIT,
    line: 'Press Esc in ${pane} to close the menu; if the limit is one model',
    why: "the Linux supervisor's usage-limit line: the card is Mac-only so far (FOLLOWUPS)",
    row: '7 on Linux',
  },
  {
    file: 'apps/desktop/Sources/TalosDesktopCore/OnboardingText.swift',
    line: 'only you can answer (a folder trust). Open Terminals',
    why: 'the setup screen line for the folder-trust question',
    row: '1',
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

  it('the deaf-thread alarm replaced the old "showing something Talos doesn\'t type into ... Open this thread in Terminals" line', () => {
    // the alarm's words live in DeafThread.swift and may never send the owner to a terminal: no hit at all, allowlisted or not
    const own = hits.filter((h) => h.file.endsWith('TalosDesktopCore/DeafThread.swift'))
    expect(own.map((h) => `${h.line} [${h.id}] ${h.text}`)).toEqual([])
    // and the old refused line is gone from the Mac's words (the Linux twin keeps its own, on the allowlist, until its alarm exists)
    const switcher = readFileSync(join(ROOT, SESSION_SWITCHER), 'utf8')
    expect(switcher).not.toMatch(/did not type your message there[^\n]*Terminals/)
    expect(switcher).not.toContain('func refusedLine')
  })

  it('the old refused line, planted again, fails the scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'talos-pane-strings-'))
    dirs.push(root)
    mkdirSync(join(root, 'apps/desktop/Sources/X'), { recursive: true })
    writeFileSync(
      join(root, 'apps/desktop/Sources/X/A.swift'),
      'let t = "This thread\'s session is showing something Talos doesn\'t type into, so Talos did not type your message there. Open this thread in Terminals to see it."\n',
    )
    const bad = judge(scan(root), ALLOWED).uncovered
    expect(bad.map((h) => h.id)).toContain('open-terminals')
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
    expect([...new Set(bad.map((h) => h.file))].sort()).toEqual([
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

  it('row 7 (the usage-limit menu) is converted: no entry waits on it, and the old line fails the scan wherever it is planted', () => {
    // the Mac, the web app and the shared code are converted; only the Linux supervisor's own lines wait (its card is a FOLLOWUPS row)
    for (const a of ALLOWED.filter((x) => x.file !== LINUX_USAGE_LIMIT)) {
      expect(a.row, `${a.file}: ${a.line}`).not.toMatch(/(?:^|[^\d])7(?:[^\d]|$)/)
      expect(`${a.line} ${a.why}`, a.file).not.toMatch(/usage.limit/i)
    }
    for (const a of ALLOWED.filter((x) => x.file === LINUX_USAGE_LIMIT)) expect(a.row).toBe('7 on Linux')
    const root = mkdtempSync(join(tmpdir(), 'talos-pane-strings-'))
    dirs.push(root)
    const plant = (rel: string, body: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    // the exact line row 7 used to say, and the other forms the tightened rule is for
    plant(
      'apps/desktop/Sources/X/Usage.swift',
      'let l = "To go on now, press Esc in this thread\'s pane in Terminals, then /model <another model>."\n',
    )
    plant('apps/desktop/Sources/X/Main.swift', 'let l = "Main hit a usage limit; press Esc in its pane, then /model"\n')
    plant('apps/bridge/src/usage.ts', "export const l = 'Check the session in Terminals'\n")
    plant('apps/bridge/src/attach.ts', 'export const l = `Run tmux attach -t t-work`\n')
    plant('apps/web/src/Help.tsx', 'export const l = <p>Press Esc in the pane, then type /model</p>\n')
    plant('apps/web/src/Cli.tsx', 'export const l = <p>Run talos-app doctor in Terminal</p>\n')
    const bad = judge(scan(root), ALLOWED).uncovered
    expect([...new Set(bad.map((h) => h.file))].sort()).toEqual([
      'apps/bridge/src/attach.ts',
      'apps/bridge/src/usage.ts',
      'apps/desktop/Sources/X/Main.swift',
      'apps/desktop/Sources/X/Usage.swift',
      'apps/web/src/Cli.tsx',
      'apps/web/src/Help.tsx',
    ])
    // not caught: a comment, a trailing remark, a feature name that is not a place to go
    const ok = mkdtempSync(join(tmpdir(), 'talos-pane-strings-'))
    dirs.push(ok)
    mkdirSync(join(ok, 'apps/web/src'), { recursive: true })
    writeFileSync(
      join(ok, 'apps/web/src/ok.ts'),
      "// press Esc in its pane in Terminals (old)\nexport const a = 'Choose Stop and wait' // was: in its pane\nexport const b = 'Terminal screen'\n",
    )
    expect(scan(ok)).toEqual([])
  })

  it('row 12 (a start that stalls, a resume that fails, thread holds) is converted on the Mac: no Mac entry waits on it, and the old lines fail the scan wherever they are planted', () => {
    // what is left under 12 is the Linux supervisor's own lines and the restart-held dialog line (rows 11 and 12 together)
    for (const a of ALLOWED.filter((x) => x.file.startsWith('apps/desktop/') && /(?:^|[^\d])12(?:[^\d]|$)/.test(x.row)))
      expect(a.file.endsWith('MainRestartCheck.swift'), `${a.file}: ${a.line}`).toBe(true)
    for (const a of ALLOWED.filter((x) => x.file === SESSION_SWITCHER)) expect(['1, 11', '10']).toContain(a.row)
    const root = mkdtempSync(join(tmpdir(), 'talos-pane-strings-'))
    dirs.push(root)
    const plant = (rel: string, body: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    // the exact words row 12 used to say
    plant(
      'apps/desktop/Sources/TalosDesktopCore/OnboardingText.swift',
      'let s = "Claude has not finished starting. Open Terminals\\u{2026} in the menu bar item and look at the pane."\n',
    )
    plant(
      'apps/desktop/Sources/TalosDesktopCore/SessionSwitcher.swift',
      'let a = "This thread\'s session has unsent text in its input box. Open this thread in Terminals to finish or clear it."\nlet b = "Open this thread in Terminals to see what it\'s waiting on."\n',
    )
    plant(
      'apps/desktop/Sources/TalosDesktopCore/SupervisorNotice.swift',
      'let c = "its model request may be stuck. Press Esc in its pane to cancel, then send again"\n',
    )
    plant(
      'apps/desktop/Sources/TalosDesktop/SupervisorController.swift',
      'case .startStalled: return "Claude has not finished starting; look at the pane"\nlet d = "Open this thread in Terminals"\n',
    )
    const bad = judge(scan(root), ALLOWED).uncovered
    expect(bad.map((h) => `${h.file.split('/').pop()}:${h.id}`).sort()).toEqual([
      'OnboardingText.swift:open-terminals',
      'OnboardingText.swift:terminals-app',
      'SessionSwitcher.swift:open-terminals',
      'SessionSwitcher.swift:open-terminals',
      'SessionSwitcher.swift:terminals-app',
      'SessionSwitcher.swift:terminals-app',
      'SupervisorController.swift:open-terminals',
      'SupervisorController.swift:terminals-app',
      'SupervisorNotice.swift:in-its-pane',
      'SupervisorNotice.swift:press-esc',
    ])
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
