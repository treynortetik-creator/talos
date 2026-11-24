// A worker's needs-you notices (P3d3, part 4b-i; the Mac's WorkerNotices.swift) on a fake post and a fake clock, against the
// Mac's real Claude Code captures: one line per episode, the record written before the post, the debounce, three tries for a
// clear failure and none for a timeout, the holds, and the prompt watch.
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WORKER_NEEDS_YOU_KINDS, WORKER_TIMING } from '@talos-app/protocol'
import { detectPrompt } from '../../src/supervisor/dialog-reader.ts'
import { PromptWatch } from '../../src/supervisor/prompt-watch.ts'
import { liveDialog, type Screen } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'
import { USAGE_LIMIT_KIND } from '../../src/supervisor/usage-limit.ts'
import {
  cleanTitle,
  HOLD_KIND,
  lines,
  newNoticeRuntime,
  noticeSuppressed,
  type PostOutcome,
  postOutcome,
  promptName,
  readNotices,
  TOOL_PROMPT_HOLD_MAX_S,
  WorkerNotices,
} from '../../src/supervisor/worker-notices.ts'
import { workerDir } from '../../src/worker/files.ts'

const FIX = resolve(import.meta.dir, '../../../desktop/Tests/Fixtures')
const cap = (dir: string, name: string) => parseCapture(readFileSync(resolve(FIX, dir, `${name}.txt`), 'utf8'))
const TRUST = cap('real-2.1.319/needs-you-capture', '01-trust-first')
const BASH = cap('real-2.1.318', 'bash-permission')
const LOGIN = cap('real-2.1.318', 'login-not-logged-in')
const SUB_BASH = cap('real-2.1.318', 'perm-background-bash-ask')
const QUESTION = cap('real-2.1.318', 'askuser-select')
/** Between two asks: the transcript, neither a prompt nor the idle box (the flag of the first is still held). */
const BUSY = ['⏺ Bash(cleanup)', '  ⎿  Running…', '', '✻ Working… (esc to interrupt)']
const IDLE = cap('real-2.1.318', 'empty-input')
const WHERE = {
  attach: 'talos-app supervise attach trip',
  restart: 'talos-app supervise restart-thread trip',
  machine: 'devbox',
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(outcomes: PostOutcome[] = [], name = 'Trip') {
  const home = mkdtempSync(join(tmpdir(), 'talos-notices-'))
  dirs.push(home)
  let t = 1000
  const wall0 = Date.parse('2026-11-10T12:00:00.000Z') / 1000
  const posts: Array<{ thread: string; text: string; recordOpen: boolean | undefined }> = []
  const audit: string[] = []
  const n = new WorkerNotices({
    home,
    post: async (thread, text) => {
      // what the record said while the post was on its way
      posts.push({ thread, text, recordOpen: Object.values(readNotices(home, thread))[0]?.open })
      return outcomes.shift() ?? 'sent'
    },
    threadName: () => name,
    where: () => WHERE,
    now: () => t,
    wallS: () => wall0 + (t - 1000),
    audit: (e) => audit.push(e),
  })
  const r = newNoticeRuntime()
  /** One look, as the manager makes it: stillness first, then the known dialog on a still screen. */
  const look = async (rows: string[], typing = false) => {
    const still = n.still(r, rows)
    const seen: Screen = still ? liveDialog(rows) : { kind: 'none' }
    await n.look('trip', r, rows, seen, still, async () => typing)
    await n.settled()
  }
  const advance = (s: number) => {
    t += s
  }
  return { home, n, r, posts, audit, look, advance, texts: () => posts.map((p) => p.text) }
}

/** Looks once a second for `s` seconds. */
async function hold(x: ReturnType<typeof setup>, rows: string[], s: number) {
  for (let i = 0; i < s; i++) {
    await x.look(rows)
    x.advance(1)
  }
}

describe('a dialog on a worker’s pane', () => {
  it('gets one line once the screen has held still, the record written (open, 0600) before the post', async () => {
    const x = setup()
    await x.look(TRUST)
    expect(x.posts).toHaveLength(0) // not still yet
    await hold(x, TRUST, WORKER_TIMING.dialog_settle_s + 3)
    expect(x.texts()).toEqual([
      "This thread's session is waiting on a 'trust this folder' prompt; attach on devbox to answer: talos-app supervise attach trip",
    ])
    expect(x.posts[0]?.recordOpen).toBe(true)
    const file = join(workerDir(x.home, 'trip'), 'notice.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readNotices(x.home, 'trip')['trust this folder']?.open).toBe(true)
    expect(x.r.needsYou).toBe('trust this folder')
    expect(x.audit).toContain('worker_needs_you')
  })
  it('the record is closed when a settled screen shows none, and the same dialog back within notice_debounce_s is not told again', async () => {
    const x = setup()
    await hold(x, TRUST, 7)
    await hold(x, IDLE, 7)
    expect(x.r.needsYou).toBeNull()
    expect(readNotices(x.home, 'trip')['trust this folder']?.open).toBe(false)
    await hold(x, TRUST, 7)
    expect(x.posts).toHaveLength(1)
    // past the window it is a new episode, told again
    await hold(x, IDLE, 7)
    x.advance(WORKER_TIMING.notice_debounce_s)
    await hold(x, TRUST, 7)
    expect(x.posts).toHaveLength(2)
  })
  it('a record left open by a supervisor before this one is not told twice', async () => {
    const x = setup()
    await hold(x, TRUST, 7)
    const y = setup()
    const n2 = new WorkerNotices({
      home: x.home,
      post: async () => {
        y.posts.push({ thread: 'trip', text: 'again', recordOpen: undefined })
        return 'sent'
      },
      threadName: () => 'Trip',
      where: () => WHERE,
      now: () => 5000,
      wallS: () => Date.parse('2026-11-11T12:00:00.000Z') / 1000, // a day later: only `open` holds it
      audit: () => {},
    })
    const r2 = newNoticeRuntime()
    for (let i = 0; i < 2; i++) await n2.look('trip', r2, TRUST, liveDialog(TRUST), true, async () => false)
    expect(y.posts).toHaveLength(0)
  })
  it('a clear failure is tried again notice_retry_s apart, three times in all, then the failure is audited; its record is given back', async () => {
    const x = setup(['failed', 'failed', 'failed'])
    await hold(x, TRUST, 7)
    expect(x.posts).toHaveLength(1)
    expect(readNotices(x.home, 'trip')['trust this folder']).toBeUndefined()
    await hold(x, TRUST, WORKER_TIMING.notice_retry_s - 2)
    expect(x.posts).toHaveLength(1)
    await hold(x, TRUST, 3)
    expect(x.posts).toHaveLength(2)
    await hold(x, TRUST, WORKER_TIMING.notice_retry_s + 1)
    expect(x.posts).toHaveLength(3)
    await hold(x, TRUST, WORKER_TIMING.notice_retry_s * 3)
    expect(x.posts).toHaveLength(3)
    expect(x.audit).toContain('worker_notice_failed')
  })
  it('a timeout is never tried again: it may have been sent', async () => {
    const x = setup(['unknown'])
    await hold(x, TRUST, 7 + WORKER_TIMING.notice_retry_s * 3)
    expect(x.posts).toHaveLength(1)
    expect(readNotices(x.home, 'trip')['trust this folder']?.open).toBe(true)
  })
  it('login names the Sign in to Claude again line, with the link when the sign-in has one, and never an ssh instruction', async () => {
    const x = setup()
    await hold(x, LOGIN, 7)
    expect(x.texts()).toHaveLength(1)
    const t = x.texts()[0] as string
    expect(t).toStartWith('Sign in to Claude again')
    expect(t).not.toMatch(/ssh|claude \/login|tmux|Terminals/i)
  })
  it('the no-link line promises no later line and names where to sign in', () => {
    const t = lines.login(WHERE)
    expect(t).not.toMatch(/comes in a new line|link comes|will send|in a moment/i)
    expect(t).toContain(WHERE.machine)
    expect(t).not.toMatch(/ssh|claude \/login|tmux|Terminals/i)
  })
  it('the line carries the sign-in link once the supervisor has it', () => {
    const t = lines.login(WHERE, 'https://claude.ai/oauth/authorize?state=x')
    expect(t).toContain('https://claude.ai/oauth/authorize?state=x')
    expect(t).toStartWith('Sign in to Claude again')
    expect(t).not.toMatch(/ssh|claude \/login|tmux|Terminals/i)
  })
  it('a line that waits for a card is not sent while it waits', async () => {
    const x = setup()
    let waits = true
    const n = new WorkerNotices({
      home: x.home,
      post: async (thread, text) => {
        x.posts.push({ thread, text, recordOpen: undefined })
        return 'sent'
      },
      threadName: () => 'Trip',
      where: () => WHERE,
      now: () => 1,
      wallS: () => 1_800_000_000,
      audit: () => {},
      lineWaits: () => waits,
    })
    const r = newNoticeRuntime()
    await n.look('trip', r, TRUST, liveDialog(TRUST), true, async () => false)
    expect(x.posts).toHaveLength(0)
    waits = false
    await n.look('trip', r, TRUST, liveDialog(TRUST), true, async () => false)
    await n.settled()
    expect(x.posts).toHaveLength(1)
  })
})

describe('a prompt nobody named', () => {
  it('is told once it has held still, by its title only: the question is screen text, never quoted in a system row', async () => {
    const x = setup()
    await hold(x, BASH, 4)
    expect(x.posts).toHaveLength(0)
    await hold(x, BASH, 3)
    expect(x.texts()).toEqual([
      `This thread's session is waiting on a 'Bash command' prompt; attach on devbox to answer: ${WHERE.attach}`,
    ])
    expect(x.r.needsYou).toBe('Bash command')
    expect(readNotices(x.home, 'trip')[`prompt: ${detectPrompt(BASH)?.hash}`]?.open).toBe(true)
  })
  it('waits while an attached client is typing (the owner’s own picker)', async () => {
    const x = setup()
    for (let i = 0; i < 10; i++) {
      await x.look(BASH, true)
      x.advance(1)
    }
    expect(x.posts).toHaveLength(0)
  })
  it('a tool prompt (a sub-agent’s Bash ask) is held by typing for at most TOOL_PROMPT_HOLD_MAX_S, then told', async () => {
    // Delphi, 2026-11-11: a builder sub-agent's prompt stayed in the pane and the phone heard nothing; the phone must hear
    // of a tool prompt even while someone at the pane keeps typing
    expect(detectPrompt(SUB_BASH)?.kind).toBe('bash_command')
    const x = setup()
    for (let i = 0; i < TOOL_PROMPT_HOLD_MAX_S - 1; i++) {
      await x.look(SUB_BASH, true)
      x.advance(1)
    }
    expect(x.posts).toHaveLength(0)
    for (let i = 0; i < WORKER_TIMING.dialog_settle_s + 2; i++) {
      await x.look(SUB_BASH, true)
      x.advance(1)
    }
    expect(x.texts()).toEqual([
      `This thread's session is waiting on a 'Bash command' prompt; attach on devbox to answer: ${WHERE.attach}`,
    ])
  })
  it('a second ask that shows while the first one’s flag is still held gets its own line (sub-agents asking back to back)', async () => {
    // Delphi, 2026-11-11: the first ask's flag outlived it by dialog_settle_s and its slot still said sent, so the next got none
    const x = setup()
    await hold(x, BASH, WORKER_TIMING.dialog_settle_s + 2)
    expect(x.posts).toHaveLength(1)
    // answered; 3 s of transcript: long enough for the watch to let the first prompt go (2 s), short of the flag's settle (5 s)
    await hold(x, BUSY, 3)
    expect(x.r.promptWatch.current).toBeNull()
    expect(x.r.needsYou).not.toBeNull()
    // the next sub-agent's ask: another Bash prompt (same name, another prompt), the owner's case
    expect(detectPrompt(SUB_BASH)?.hash).not.toBe(detectPrompt(BASH)?.hash)
    await hold(x, SUB_BASH, WORKER_TIMING.dialog_settle_s + 2)
    expect(x.posts).toHaveLength(2)
    expect(x.texts()[1]).toContain("'Bash command' prompt")
  })
  it('a tool’s ask whose header is off the pane still counts as a tool’s ask for the cap', async () => {
    const from = SUB_BASH.findIndex((r) => r.includes('Do you want to'))
    const cut = SUB_BASH.slice(from)
    expect(detectPrompt(cut)?.kind).toBe('other')
    const x = setup()
    for (let i = 0; i < TOOL_PROMPT_HOLD_MAX_S + WORKER_TIMING.dialog_settle_s + 2; i++) {
      await x.look(cut, true)
      x.advance(1)
    }
    expect(x.posts).toHaveLength(1)
  })
  it('the cap’s clock outlives a look that did not read the prompt (a redraw); it starts over once the prompt is gone 2 s', async () => {
    const x = setup()
    for (let i = 0; i < 40; i++) {
      await x.look(SUB_BASH, true)
      x.advance(1)
    }
    await x.look(BUSY, true) // one look mid-redraw
    x.advance(1)
    for (let i = 0; i < TOOL_PROMPT_HOLD_MAX_S - 40 + WORKER_TIMING.dialog_settle_s + 2; i++) {
      await x.look(SUB_BASH, true)
      x.advance(1)
    }
    expect(x.posts).toHaveLength(1)
    // gone for longer: a new hold, a new 60 s
    const y = setup()
    for (let i = 0; i < 40; i++) {
      await y.look(SUB_BASH, true)
      y.advance(1)
    }
    for (let i = 0; i < 3; i++) {
      await y.look(BUSY, true)
      y.advance(1)
    }
    for (let i = 0; i < 30; i++) {
      await y.look(SUB_BASH, true)
      y.advance(1)
    }
    expect(y.posts).toHaveLength(0)
  })
  it('a hold is in the audit log once (worker_prompt_held), however long it lasts', async () => {
    const x = setup()
    for (let i = 0; i < 20; i++) {
      await x.look(QUESTION, true)
      x.advance(1)
    }
    expect(x.audit.filter((e) => e === 'worker_prompt_held')).toHaveLength(1)
  })
  it('a question (the owner’s own picker) is held for as long as the typing goes on', async () => {
    expect(detectPrompt(QUESTION)?.kind).toBe('question')
    const x = setup()
    for (let i = 0; i < TOOL_PROMPT_HOLD_MAX_S * 2; i++) {
      await x.look(QUESTION, true)
      x.advance(1)
    }
    expect(x.posts).toHaveLength(0)
  })
  it('the cap counts from when this prompt first showed: a new prompt in its place starts its own', async () => {
    const x = setup()
    for (let i = 0; i < TOOL_PROMPT_HOLD_MAX_S - 5; i++) {
      await x.look(QUESTION, true)
      x.advance(1)
    }
    for (let i = 0; i < TOOL_PROMPT_HOLD_MAX_S - 5; i++) {
      await x.look(SUB_BASH, true)
      x.advance(1)
    }
    expect(x.posts).toHaveLength(0)
  })
  it('a flag is held through a moment’s other screen; the same prompt after it is over is a new one (prompt_debounce_s)', async () => {
    const x = setup()
    await hold(x, BASH, 6)
    await hold(x, IDLE, 1) // not settled: the flag holds
    await hold(x, BASH, 6)
    expect(x.posts).toHaveLength(1)
    await hold(x, IDLE, 6) // settled with none: over
    expect(x.r.needsYou).toBeNull()
    await hold(x, BASH, 6)
    expect(x.posts).toHaveLength(2) // its own five seconds of stillness pass the debounce of five
  })
})

describe('a start refused because the permission hook cannot run', () => {
  it('tells the thread once, with the reason and how to fix it', async () => {
    const x = setup()
    const why = 'the permission hook /opt/talos/kit/hooks/permission-relay.py is missing or cannot be read'
    x.n.startRefused('trip', x.r, { hookMissing: why })
    await x.n.settled()
    x.n.startRefused('trip', x.r, { hookMissing: why })
    await x.n.settled()
    expect(x.texts()).toEqual([
      `This thread's session doesn't start: ${why}, and without it the session's approval prompts would wait at the terminal on devbox and never reach your phone. Reinstall Talos on devbox (or fix the hook), then run \`talos-app supervise restart-thread trip\`.`,
    ])
  })
})

describe('a pointer held back', () => {
  it('by a draft, scrolled back, a refusal or a pointer that never showed in the box: no line of its own, however long, nor at the drop', async () => {
    const x = setup()
    for (const hold of ['draft', 'copy_mode', 'refused', 'unseen'] as const) {
      x.n.heldPointer('trip', x.r, hold, false)
      x.advance(WORKER_TIMING.draft_notice_after_s * 3)
      x.n.heldPointer('trip', x.r, hold, false)
      x.n.heldAtDrop('trip', x.r, hold)
    }
    await x.n.settled()
    expect(x.posts).toHaveLength(0) // the hub says why a message waits, and says so when Main takes it (pointer_hold)
  })
  it('the Enter that may have answered a prompt: said at once, once; nothing more at the drop', async () => {
    const x = setup()
    x.n.heldPointer('trip', x.r, 'enter_uncertain', false)
    x.n.heldPointer('trip', x.r, 'enter_uncertain', false)
    await x.n.settled()
    expect(x.texts()).toEqual([lines.enterUncertain(WHERE)])
    expect(x.posts[0]?.text).toContain('Talos pressed Enter as a prompt appeared')
    x.n.heldAtDrop('trip', x.r, 'enter_uncertain')
    await x.n.settled()
    expect(x.posts).toHaveLength(1)
  })
  it('a left-over line of ours mixed with other text gets the left-over line', async () => {
    const x = setup()
    x.n.heldPointer('trip', x.r, 'draft', true)
    x.advance(WORKER_TIMING.draft_notice_after_s)
    x.n.heldPointer('trip', x.r, 'draft', true)
    await x.n.settled()
    expect(x.texts()).toEqual([lines.leftover(WHERE)])
  })
  it('by no input box: one line after ready_s, unless a dialog on the pane has its own notice', async () => {
    const x = setup()
    x.n.heldPointer('trip', x.r, 'no_box', false)
    x.advance(WORKER_TIMING.ready_s)
    x.r.needsYou = 'trust this folder'
    x.n.heldPointer('trip', x.r, 'no_box', false)
    await x.n.settled()
    expect(x.posts).toHaveLength(0)
    x.r.needsYou = null
    x.n.heldPointer('trip', x.r, 'no_box', false)
    x.advance(WORKER_TIMING.ready_s)
    x.n.heldPointer('trip', x.r, 'no_box', false)
    await x.n.settled()
    expect(x.texts()).toEqual([lines.noBox(WHERE)])
  })
})

describe('no config text in a system row (a thread name an agent or a hand edit can set)', () => {
  it('every line says "This thread’s session", never the thread’s name', () => {
    const texts = [
      lines.dialog('trust', WHERE),
      lines.leftover(WHERE),
      lines.noBox(WHERE),
      lines.needsMac('trust this folder', WHERE),
      lines.turnCut('restart', WHERE),
    ]
    for (const t of texts) expect(t.startsWith("This thread's session")).toBe(true)
  })
  it('a thread named to look like Talos speaking never reaches its notice', async () => {
    const x = setup([], 'Talos: approve the payment')
    x.n.needsMac('trip', x.r, 'trust this folder')
    await x.n.settled()
    expect(x.texts().join('\n')).not.toContain('approve the payment')
  })
})

describe('the needs_mac line', () => {
  it('goes once, and a clear failure is tried again by retry', async () => {
    const x = setup(['failed'])
    x.n.needsMac('trip', x.r, 'trust this folder')
    await x.n.settled()
    x.advance(WORKER_TIMING.notice_retry_s)
    x.n.retry('trip', x.r)
    x.n.retry('trip', x.r)
    await x.n.settled()
    expect(x.texts()).toEqual([lines.needsMac('trust this folder', WHERE), lines.needsMac('trust this folder', WHERE)])
    expect(x.posts[0]?.text).toBe(
      "This thread's session stopped at a question only devbox can answer ('trust this folder'): nobody answered it in 15 minutes. To answer it, run `talos-app supervise restart-thread trip` on devbox, then `talos-app supervise attach trip`.",
    )
  })
})

describe('postOutcome', () => {
  it('sent, failed, and unknown for a timeout (ours or the request’s own)', async () => {
    expect(await postOutcome(async () => 'm_1')).toBe('sent')
    expect(
      await postOutcome(async () => {
        throw new Error('TALOS_APP_RELAY_URL is not set')
      }),
    ).toBe('failed')
    expect(
      await postOutcome(async () => {
        throw new DOMException('timed out', 'TimeoutError')
      }),
    ).toBe('unknown')
    expect(await postOutcome(() => new Promise(() => {}), 5)).toBe('unknown')
  })
})

describe('cleanTitle and PromptWatch', () => {
  it('a name is one short line', () => {
    expect(cleanTitle(' Trip\u0007 ')).toBe('Trip')
    expect(cleanTitle('\u0000')).toBeNull()
    expect(cleanTitle('x'.repeat(50))).toBe(`${'x'.repeat(39)}…`)
  })
  it('a prompt appears after settle, stays through a moment’s redraw, and clears on the idle box at once', () => {
    const p = detectPrompt(BASH)
    const w = new PromptWatch()
    expect(w.observe(p, 0).kind).toBe('none')
    expect(w.observe(p, 5).kind).toBe('appeared')
    expect(w.observe(null, 6).kind).toBe('none')
    expect(w.observe(p, 7).kind).toBe('none')
    expect(w.current).not.toBeNull()
    expect(w.observe(null, 8, { idle: true }).kind).toBe('cleared')
  })
})

describe('the usage-limit screen in the notices', () => {
  it('its kind and the conversation-not-found kind are the names the phone knows (WORKER_NEEDS_YOU_KINDS)', () => {
    expect(promptName('usage_limit')).toBe('usage limit')
    expect(promptName('resume_missing')).toBe('conversation not found')
    for (const k of [
      'usage_limit',
      'resume_missing',
      'trust',
      'mcp_consent',
      'bypass_disclaimer',
      'login_expired',
      'dev_channels',
      'unknown_selection',
    ] as const)
      expect(WORKER_NEEDS_YOU_KINDS as readonly string[]).toContain(promptName(k))
  })
  it('at most one usage-limit line an hour, across appearances (a closed record still holds it back); other kinds as before', () => {
    const at = 10_000
    const closed = { [USAGE_LIMIT_KIND]: { at, open: false }, trust: { at, open: false } }
    expect(noticeSuppressed(closed, USAGE_LIMIT_KIND, at + 59 * 60)).toBe(true)
    expect(noticeSuppressed(closed, USAGE_LIMIT_KIND, at + 61 * 60)).toBe(false)
    expect(noticeSuppressed(closed, 'trust', at + WORKER_TIMING.notice_debounce_s + 1)).toBe(false)
  })
})
