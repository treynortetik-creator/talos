// What the owner is told, and how: notify-send's argv (never run here: no notification reaches the desktop from a test).
import { describe, expect, it } from 'bun:test'
import {
  cleanAgentName,
  escapeMarkup,
  NOTICE_MIN_GAP_MS,
  type Notice,
  NoticeGate,
  noticeFor,
  notifySendArgv,
  phoneThread,
  readAppConfig,
  viewCommand,
} from '../../src/supervisor/notices.ts'

const VIEW = viewCommand('talos', '/h/tmux.conf', 'agent')
const must = (n: Notice | null) => {
  if (!n) throw new Error('no notice')
  return n
}

describe('the notices', () => {
  it('a stop that needs the owner tells the phone too; the owner’s own stop tells nobody', () => {
    const loop = noticeFor({ kind: 'stopped', reason: 'crash_loop' }, 'Ada', '14:05', VIEW)
    expect(loop).toMatchObject({ notice: 'crash_loop', phone: "Ada's session stopped restarting at 14:05" })
    const clean = noticeFor({ kind: 'stopped', reason: 'clean_exit_loop' }, null, '14:05', VIEW)
    expect(clean?.phone).toBe('Your agent keeps exiting cleanly, so Talos stopped it at 14:05')
    expect(noticeFor({ kind: 'stopped', reason: 'user' }, 'Ada', '14:05', VIEW)).toBeNull()
    expect(noticeFor({ kind: 'stopped', reason: 'resume_missing' }, 'Ada', '14:05', VIEW)?.phone).toBe(
      "Ada's last conversation can't be resumed, so Talos stopped it and changed nothing. Start a new conversation on the computer it runs on (14:05)",
    )
  })
  it('needs-you says what and where; after an unattended restart the phone hears it too', () => {
    const n = must(noticeFor({ kind: 'needs_you', needs: { kind: 'dialog', dialog: 'trust' } }, 'Ada', '9:00', VIEW))
    expect(n.body).toContain('folder-trust')
    expect(n.body).toContain(VIEW)
    expect(n.phone).toBeNull()
    const away = must(
      noticeFor({ kind: 'needs_you', needs: { kind: 'confirm_cold_start' }, unattended: true }, 'Ada', '09:00', VIEW),
    )
    expect(away.phone).toBe('Ada restarted after a crash and is waiting for you on the computer (09:00)')
  })
  it('Main on the usage-limit screen: what kind of limit, the reset and the way on; never "answer"', () => {
    const n = must(
      noticeFor(
        {
          kind: 'needs_you',
          needs: { kind: 'usage_limit', model: 'Fable', limit: 'model', resets: '4pm (Europe/Paris)' },
        },
        'Ada',
        '9:00',
        VIEW,
      ),
    )
    expect(n.body).toBe(
      `Ada hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen: some of its options spend money or change your plan. To go on now, press Esc in its pane (${VIEW}), then /model <another model>.`,
    )
    for (const w of ['answer', 'approve', 'accept', 'confirm']) expect(n.body.toLowerCase()).not.toContain(w)
    // a limit for every model: says so, and never advises another model
    const weekly = must(
      noticeFor(
        { kind: 'needs_you', needs: { kind: 'usage_limit', model: null, limit: 'weekly', resets: null } },
        'Ada',
        '9:00',
        VIEW,
      ),
    )
    expect(weekly.body).toContain('Ada hit its weekly limit, which covers every model.')
    expect(weekly.body).not.toContain('/model')
  })
  it('the bridge reason (log text) never goes into a banner, and a name is cleaned', () => {
    const bridge = must(
      noticeFor(
        { kind: 'needs_you', needs: { kind: 'bridge_not_live', reason: '<a href="x">click</a>' } },
        'Ada',
        '',
        VIEW,
      ),
    )
    expect(bridge.body).toBe('Ada is running but its Talos bridge did not start. See why: talos-app supervise status')
    expect(cleanAgentName('A\nB\u0007C')).toBe('A B C')
    expect(cleanAgentName('x'.repeat(60))).toHaveLength(40)
    expect(cleanAgentName(null)).toBe('Your agent')
    expect(escapeMarkup('a & <b>')).toBe('a &amp; &lt;b&gt;')
    const argv = notifySendArgv(
      must(noticeFor({ kind: 'restarted_after_crash', resumed: true }, 'Tom & <Jerry>', '', VIEW)),
      null,
    )
    expect(argv.at(-1)).toBe('Tom &amp; &lt;Jerry&gt; restarted after a crash and resumed')
  })
  it('a restart that gave up tells the phone; a plain failed start does not', () => {
    const gave = noticeFor({ kind: 'stopped', reason: 'start_failed', gaveUp: true }, 'Ada', '14:05', VIEW)
    expect(gave?.phone).toBe('Ada stopped and could not be restarted, so Talos gave up at 14:05')
    expect(noticeFor({ kind: 'stopped', reason: 'start_failed' }, 'Ada', '14:05', VIEW)?.phone).toBe(
      "Talos couldn't start Ada (14:05). The reason is on the computer it runs on",
    )
  })
  it('a start that stalls is a line in the thread, with no attach command and no terminal', () => {
    const n = must(noticeFor({ kind: 'needs_you', needs: { kind: 'start_stalled' } }, 'Ada', '14:05', VIEW))
    expect(n.phone).toBe(
      "Ada hasn't finished starting after 2 minutes. Talos left it as it is, so it needs a restart on the computer it runs on (14:05)",
    )
    for (const e of [
      { kind: 'needs_you', needs: { kind: 'start_stalled' } },
      { kind: 'stopped', reason: 'resume_missing' },
      { kind: 'stopped', reason: 'start_failed' },
    ] as const) {
      const phone = must(noticeFor(e, 'Ada', '14:05', VIEW)).phone ?? ''
      expect(phone).not.toMatch(/tmux|attach|terminal|pane|ssh/i)
      expect(phone).not.toContain(VIEW)
    }
  })
  it('a blocked crash restart tells the phone; a blocked owner start does not', () => {
    const b = [{ resource: 'channels' as const, holderPid: 9, sessionPid: 9, folder: '/x' }]
    expect(noticeFor({ kind: 'blocked', blockers: b, afterCrash: true }, 'Ada', '14:05', VIEW)?.phone).toContain(
      'could not restart it',
    )
    expect(noticeFor({ kind: 'blocked', blockers: b }, 'Ada', '14:05', VIEW)?.phone).toBeNull()
  })
  it('restarted says "resumed" only when it resumed', () => {
    expect(noticeFor({ kind: 'restarted_after_crash', resumed: false }, 'Ada', '', VIEW)?.body).toBe(
      'Ada restarted after a crash',
    )
  })
  it('notify-send replaces the tag’s last one by id, and quiet is no sound (low urgency), never no banner', () => {
    const quiet = notifySendArgv(
      must(noticeFor({ kind: 'restarted_after_crash', resumed: true }, 'Ada', '', VIEW)),
      '42',
    )
    expect(quiet).toContain('--print-id')
    expect(quiet).toContain('--replace-id=42')
    expect(quiet).toContain('--hint=string:x-canonical-private-synchronous:sup:restarted')
    expect(quiet).toContain('--hint=boolean:suppress-sound:true')
    expect(quiet).toContain('--urgency=low')
    expect(quiet.slice(-3, -2)).toEqual(['--'])
    const loud = notifySendArgv(must(noticeFor({ kind: 'stopped', reason: 'crash_loop' }, 'Ada', '', VIEW)), null)
    expect(loud).toContain('--urgency=normal')
    expect(loud.some((a) => a.startsWith('--replace-id'))).toBe(false)
    expect(loud).not.toContain('--hint=boolean:suppress-sound:true')
    // nothing is offered to click: an answer never comes from a notification
    expect(loud.some((a) => a.startsWith('--action') || a === '-A')).toBe(false)
  })
  it('the same text once a minute per tag; a changed one replaces at once; only a shown one counts; one in flight blocks', () => {
    const g = new NoticeGate()
    const a = must(noticeFor({ kind: 'needs_you', needs: { kind: 'start_stalled' } }, 'Ada', '', VIEW))
    const b = must(noticeFor({ kind: 'needs_you', needs: { kind: 'stuck' } }, 'Ada', '', VIEW))
    expect(g.due(a, 0)).toBe(true)
    expect(g.due(a, 0)).toBe(false) // in flight
    g.failed(a) // notify-send failed (no notification service yet): due again
    expect(g.due(a, 1)).toBe(true)
    g.shown(a, 1, '17')
    expect(g.due(a, 1000)).toBe(false) // the same text within the minute
    expect(g.due(b, 1000)).toBe(true) // another kind: replaces the card at once
    expect(g.replaceId(b)).toBe('17')
    g.shown(b, 1000, 'not-a-number')
    expect(g.replaceId(b)).toBe('17')
    expect(g.due(b, 1000 + NOTICE_MIN_GAP_MS)).toBe(true)
  })
  it('the title is plain text (never escaped), the body escaped markup', () => {
    const argv = notifySendArgv(must(noticeFor({ kind: 'stopped', reason: 'resume_missing' }, 'A&B', '', VIEW)), null)
    expect(argv.at(-2)).toBe("The last conversation can't be resumed")
    expect(argv.at(-1)).toContain('A&amp;B')
  })
  it('the view command names this supervisor’s socket and quotes a path with a space', () => {
    expect(viewCommand('talos-live', '/home/alex/My Talos/tmux.conf', 'agent')).toBe(
      "tmux -L talos-live -f '/home/alex/My Talos/tmux.conf' -u attach-session -t =agent",
    )
  })
  it('reads the agent’s name and default thread from config.json, nothing else', () => {
    expect(readAppConfig({ agent: { name: 'Ada' }, default_thread: 'general' })).toEqual({
      agentName: 'Ada',
      defaultThread: 'general',
    })
    expect(readAppConfig({ agent: { name: 3 } })).toEqual({ agentName: null, defaultThread: null })
    expect(readAppConfig(undefined)).toEqual({ agentName: null, defaultThread: null })
  })
  // the sandbox breaker's #3: a damaged config.json crash-looped Main and the phone line was skipped ("no default thread")
  it('the phone line goes to the default thread, and to the inbox when config.json has none or cannot be read', () => {
    expect(phoneThread({ defaultThread: 'general' })).toBe('general')
    expect(phoneThread({ defaultThread: null })).toBe('inbox')
    expect(phoneThread({ defaultThread: '--relay-url' })).toBe('inbox') // never a value that is not a thread id
  })
})
