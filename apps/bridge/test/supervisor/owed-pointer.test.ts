// The owed pointer (P3d3), on a fake pane that draws Claude's input box the way 2.1.318 does: the empty box shows a dim
// placeholder, text typed into it is drawn at normal intensity, Enter submits what the box holds.
import { describe, expect, it } from 'bun:test'
import {
  CLAIM_DEADLINE_COLD_MS,
  CLAIM_DEADLINE_MS,
  type PtySendResult,
  WORKER_POINTER,
  WORKER_POINTER_TEXT,
} from '@talos-app/protocol'
import {
  mayType,
  NOTHING_OWED,
  type OwedState,
  owe,
  type PointerPane,
  persisted,
  restored,
  typeOwedPointer,
  wakeTooOld,
} from '../../src/supervisor/owed-pointer.ts'

const RULE = '─'.repeat(60)

class FakePane implements PointerPane {
  box = '' // what the input box holds
  submitted: string[] = []
  clients: number[] | null = []
  showBox = true
  dialog = false
  /** Keys typed are not drawn until this many more looks (a slow frame). */
  lagLooks = 0
  /** Keys typed are dropped (a pane that lost them). */
  dropKeys = false
  failEnter: PtySendResult | null = null
  backspaces = 0
  async clientActivities() {
    return this.clients
  }
  mode: boolean | null = false
  async inCopyMode() {
    return this.mode
  }
  async visibleRowsEscaped() {
    if (this.lagLooks > 0) {
      this.lagLooks--
      return this.rows('')
    }
    return this.rows(this.box)
  }
  private rows(text: string) {
    const body = this.dialog
      ? ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit']
      : ['history']
    if (!this.showBox || this.dialog) return body // a dialog is drawn in the input box's place
    const line = text ? `❯ ${text}` : '❯ \u001b[7mT\u001b[0m\u001b[2mry "fix lint errors"\u001b[0m'
    return [...body, RULE, line, RULE]
  }
  async sendText(t: string): Promise<PtySendResult> {
    if (!this.dropKeys) this.box += t
    return 'sent'
  }
  async sendEnterKey() {
    if (this.failEnter) return this.failEnter
    this.submitted.push(this.box)
    this.box = ''
    return 'sent' as const
  }
  async sendBackspaces(n: number) {
    this.backspaces++
    this.box = [...this.box].slice(0, Math.max(0, [...this.box].length - n)).join('')
    return 'sent' as const
  }
}

const NOW = Date.parse('2026-11-10T12:00:00.000Z')
const owed = (over: Partial<OwedState> = {}): OwedState => ({
  ...owe(NOTHING_OWED, { cold: false, nowMs: NOW, wakeAtMs: null }),
  ...over,
})
const tick = (pane: FakePane, state: OwedState, o: { nowMs?: number; awake?: number } = {}) =>
  typeOwedPointer({ pane, state, nowMs: o.nowMs ?? NOW, awake: o.awake ?? 100, sleep: async () => {} })

describe('owing a pointer', () => {
  it('the deadline counts from the wake (or its taking, if earlier), longer for a cold start; a newer wake can only push it out', () => {
    const a = owe(NOTHING_OWED, { cold: false, nowMs: NOW, wakeAtMs: NOW - 10_000 })
    expect(a.until).toBe(NOW - 10_000 + CLAIM_DEADLINE_MS)
    expect(owe(NOTHING_OWED, { cold: true, nowMs: NOW, wakeAtMs: null }).until).toBe(NOW + CLAIM_DEADLINE_COLD_MS)
    expect(owe(a, { cold: false, nowMs: NOW + 5000, wakeAtMs: null }).until).toBe(a.until) // no wake: kept
    expect(owe(a, { cold: false, nowMs: NOW + 5000, wakeAtMs: NOW + 5000 }).until).toBe(NOW + 5000 + CLAIM_DEADLINE_MS)
    expect(owe(a, { cold: false, nowMs: NOW + 5000, wakeAtMs: NOW - 60_000 }).until).toBe(a.until) // an older wake: never earlier
  })
  it('a new wake starts a fresh pointer after an Enter that may have answered a prompt; no wake keeps the hold (Fable R2-1)', () => {
    const held = { ...owe(NOTHING_OWED, { cold: false, nowMs: NOW, wakeAtMs: NOW }), enterUncertain: true }
    expect(owe(held, { cold: false, nowMs: NOW + 5000, wakeAtMs: null })).toBe(held)
    const next = owe(held, { cold: false, nowMs: NOW + 5000, wakeAtMs: NOW + 5000 })
    expect(next).toEqual({ ...NOTHING_OWED, pending: true, until: NOW + 5000 + CLAIM_DEADLINE_MS })
    expect(next.enterUncertain).toBeUndefined()
  })
  it('a wake older than the longest claim owes nothing', () => {
    expect(wakeTooOld(NOW - WORKER_POINTER.longest_claim_s * 1000 - 1, NOW)).toBe(true)
    expect(wakeTooOld(NOW - 60_000, NOW)).toBe(false)
  })
  it('kept in workers.json and read back as restored; a time that cannot be read is long past', () => {
    const s = owed({ enterOwed: true })
    expect(persisted(s)).toEqual({ pointer_owed_until: new Date(s.until as number).toISOString(), enter_owed: true })
    expect(persisted(NOTHING_OWED)).toEqual({})
    expect(restored(persisted(s))).toMatchObject({ pending: true, enterOwed: true, restored: true, until: s.until })
    expect(restored({ pointer_owed_until: 'soon' }).until).toBe(0)
    expect(restored({})).toEqual(NOTHING_OWED)
  })
})

describe('the typing guard', () => {
  it('only at the prompt, onto a visible box without a draft, and not within 10 s of a client’s keys', () => {
    const base = { dialog: false, box: true, draft: false, lastClientMs: null, nowMs: NOW }
    expect(mayType(base)).toBe(true)
    expect(mayType({ ...base, dialog: true })).toBe(false)
    expect(mayType({ ...base, box: false })).toBe(false)
    expect(mayType({ ...base, draft: true })).toBe(false)
    expect(mayType({ ...base, lastClientMs: NOW - 9_000 })).toBe(false)
    expect(mayType({ ...base, lastClientMs: NOW - 10_000 })).toBe(true)
  })
  it('on the pane: a draft holds it (and says so), no box holds it, an unreadable client list types nothing', async () => {
    const p = new FakePane()
    p.box = 'my half-typed thought'
    expect(await tick(p, owed())).toMatchObject({ held: 'draft', delivered: false })
    expect(p.box).toBe('my half-typed thought')
    const q = new FakePane()
    q.showBox = false
    expect(await tick(q, owed())).toMatchObject({ held: 'no_box', delivered: false })
    const r = new FakePane()
    r.clients = null
    expect(await tick(r, owed())).toMatchObject({ used: true, delivered: false })
    expect(r.box).toBe('')
    const d = new FakePane()
    d.dialog = true
    expect((await tick(d, owed())).delivered).toBe(false)
    expect(d.box).toBe('')
  })
})

describe('typing it', () => {
  it('types the line, sees exactly it in the box, then Enter: delivered, and nothing is owed any more', async () => {
    const p = new FakePane()
    const r = await tick(p, owed())
    expect(r).toMatchObject({ delivered: true, wroteLine: true })
    expect(p.submitted).toEqual([WORKER_POINTER_TEXT])
    expect(r.state.pending).toBe(false)
  })
  it('a slow frame: Enter waits for the line to be drawn (ten looks), never presses on an empty box', async () => {
    const p = new FakePane()
    p.lagLooks = 2
    expect((await tick(p, owed())).delivered).toBe(true)
    const q = new FakePane()
    q.lagLooks = 99
    const r = await tick(q, owed())
    expect(r.delivered).toBe(false)
    expect(q.submitted).toEqual([])
    expect(r.state.enterOwed).toBe(true) // the line is in the box; the next tick finishes the Enter
  })
  it('typed and never seen in the box (a menu kept the focus, or keys were lost): never typed again, held unseen (Fable R5-1)', async () => {
    const p = new FakePane()
    p.dropKeys = true
    let typed = 0
    const send = p.sendText.bind(p)
    p.sendText = async (t: string) => {
      typed++
      return send(t)
    }
    let r = await tick(p, owed(), { awake: 100 })
    expect(r.state).toMatchObject({ enterOwed: true, unseenSince: 100 })
    r = await tick(p, r.state, { awake: 102 }) // within the lag: waiting for the screen, no hold yet
    expect(r.held).toBeNull()
    for (let k = 1; k <= 40; k++) {
      r = await tick(p, r.state, { awake: 100 + WORKER_POINTER.screen_lag_s + k })
      expect(r.held).toBe('unseen')
      expect(r.delivered).toBe(false)
    }
    expect(typed).toBe(1)
    expect(p.submitted).toEqual([])
  })
  it('a line seen in the box and then cleared by the owner is typed again (only that: it was seen)', async () => {
    const p = new FakePane()
    let typed = 0
    const send = p.sendText.bind(p)
    p.sendText = async (t: string) => {
      typed++
      return send(t)
    }
    p.failEnter = 'failed' // the Enter does not go: the line stays in the box
    let r = await tick(p, owed(), { awake: 100 })
    r = await tick(p, r.state, { awake: 101 }) // seen in the box
    expect(r.state).toMatchObject({ enterOwed: true, unseenSince: null })
    p.box = '' // the owner cleared it
    p.failEnter = null
    r = await tick(p, r.state, { awake: 102 })
    expect(typed).toBe(2)
    expect(r.delivered).toBe(true)
    expect(p.submitted).toEqual([WORKER_POINTER_TEXT])
  })
  it('typed and never seen, then a supervisor restart: the next one holds it unseen and never types it again (Fable R6-4)', async () => {
    const p = new FakePane()
    p.dropKeys = true
    const r = await tick(p, owed(), { awake: 100 })
    const kept = persisted(r.state)
    expect(kept).toMatchObject({ enter_owed: true, pointer_unseen: true })
    let typed = 0
    p.sendText = async () => {
      typed++
      return 'sent' as const
    }
    // the next supervisor: its own clock starts anew
    const again = await tick(p, restored(kept), { awake: 1 })
    expect(again.held).toBe('unseen')
    expect(typed).toBe(0)
    // seen after all (a late frame): no longer unseen, and nothing more is kept for it
    expect(persisted({ ...again.state, unseenSince: null })).not.toHaveProperty('pointer_unseen')
  })
  it('a copy-mode hold says so (for its notice); a mode that cannot be read says nothing yet', async () => {
    const p = new FakePane()
    p.mode = true
    expect((await tick(p, owed())).held).toBe('copy_mode')
    const q = new FakePane()
    q.mode = null
    expect((await tick(q, owed())).held).toBeNull()
  })
  it('in copy mode (the owner scrolled back), or a mode that cannot be read, nothing is typed or pressed', async () => {
    for (const mode of [true, null]) {
      const p = new FakePane()
      p.mode = mode
      const r = await tick(p, owed())
      expect(r.delivered).toBe(false)
      expect(p.box).toBe('')
    }
  })
  it('a typed line whose send timed out counts as typed: it is never typed a second time on top', async () => {
    const p = new FakePane()
    p.sendText = async (t: string) => {
      p.box += t
      return 'unknown' as const
    }
    const r = await tick(p, owed())
    expect(r.delivered).toBe(true)
    expect(p.submitted).toEqual([WORKER_POINTER_TEXT])
  })
  it('a send the host key guard refused: held as refused (so the thread is told why), still owed, nothing typed (Fable R2-1)', async () => {
    const p = new FakePane()
    p.sendText = async () => 'refused' as const
    const r = await tick(p, owed())
    expect(r.held).toBe('refused')
    expect(r.delivered).toBe(false)
    expect(r.state.pending).toBe(true)
    expect(p.box).toBe('')
  })
  it('an Enter the key guard refused: not delivered, held as refused, the line still in the box (Fable R3-5)', async () => {
    const p = new FakePane()
    p.sendEnterKey = async () => 'refused' as const
    const r = await tick(p, owed())
    expect(r.delivered).toBe(false)
    expect(r.held).toBe('refused')
    expect(r.state.pending).toBe(true)
    expect(p.submitted).toEqual([])
  })
  it('an Enter that timed out counts as sent: the line is never typed twice', async () => {
    const p = new FakePane()
    p.failEnter = 'unknown'
    const r = await tick(p, owed())
    expect(r.delivered).toBe(true)
    expect(r.state.pending).toBe(false)
  })
  it('our own line already in the box (typed before a restart) gets its Enter without being typed again', async () => {
    const p = new FakePane()
    p.box = WORKER_POINTER_TEXT
    const r = await tick(p, owed({ enterOwed: true }))
    expect(r.delivered).toBe(true)
    expect(p.submitted).toEqual([WORKER_POINTER_TEXT])
  })
})

describe('the Enter and the file', () => {
  it('the Enter is reported before the check reads the pane, so the file can say done first', async () => {
    const p = new FakePane()
    const order: string[] = []
    const look = p.visibleRowsEscaped.bind(p)
    let entered = false
    const send = p.sendEnterKey.bind(p)
    p.sendEnterKey = async () => {
      entered = true
      return send()
    }
    p.visibleRowsEscaped = async () => {
      if (entered) order.push('read')
      return look()
    }
    await typeOwedPointer({
      pane: p,
      state: owed(),
      nowMs: NOW,
      awake: 100,
      sleep: async () => {},
      onEnter: () => order.push('written'),
    })
    expect(order[0]).toBe('written')
  })
  it('an Enter that timed out still reports itself, and the record it hands over reads as delivered', async () => {
    const p = new FakePane()
    p.failEnter = 'unknown'
    const kept: OwedState[] = []
    await typeOwedPointer({
      pane: p,
      state: owed(),
      nowMs: NOW,
      awake: 100,
      sleep: async () => {},
      onEnter: (s) => kept.push(s),
    })
    expect(kept).toHaveLength(1)
    expect(persisted(kept[0] as OwedState)).toEqual({})
  })
  it('typed but not entered, then a relaunch: the line is entered exactly once and typed no more', async () => {
    const p = new FakePane()
    p.failEnter = 'refused' // typed, the Enter never went
    const first = await tick(p, owed())
    expect(p.submitted).toEqual([])
    const kept = persisted(first.state)
    expect(kept).toMatchObject({ enter_owed: true })
    p.failEnter = null
    let typed = 0
    const send = p.sendText.bind(p)
    p.sendText = async (t) => {
      typed++
      return send(t)
    }
    const again = await tick(p, restored(kept), { awake: 1 })
    expect(typed).toBe(0)
    expect(p.submitted).toEqual([WORKER_POINTER_TEXT])
    expect(again.delivered).toBe(true)
    // and a second relaunch from what is now kept finds nothing owed
    expect(persisted(again.state)).toEqual({})
  })
})

describe('a restored pointer past its deadline', () => {
  const late = () => ({ ...restored(persisted(owed({ enterOwed: true }))) })
  const after = NOW + CLAIM_DEADLINE_MS + 1
  it('our line alone, no client attached: Backspaced away, at most three times; nothing is typed', async () => {
    const p = new FakePane()
    p.box = WORKER_POINTER_TEXT
    const r = await tick(p, late(), { nowMs: after })
    expect(p.box).toBe('')
    expect(p.submitted).toEqual([])
    expect(r.state.clears).toBe(1)
    const stuck = new FakePane()
    stuck.box = WORKER_POINTER_TEXT
    stuck.sendBackspaces = async () => 'sent' // a box that does not clear
    let s = late()
    for (let i = 0; i < 5; i++) s = (await tick(stuck, s, { nowMs: after })).state
    expect(s.clears).toBe(WORKER_POINTER.late_clears)
    expect(s.leftover).toBe(true)
  })
  it('with a client attached, or mixed with the owner’s text, it is held and the thread is told, never cleared', async () => {
    const p = new FakePane()
    p.box = WORKER_POINTER_TEXT
    p.clients = [NOW - 600_000]
    const r = await tick(p, late(), { nowMs: after })
    expect(p.backspaces).toBe(0)
    expect(r).toMatchObject({ held: 'draft' })
    expect(r.state.leftover).toBe(true)
    const q = new FakePane()
    q.box = `${WORKER_POINTER_TEXT} and my words`
    expect((await tick(q, late(), { nowMs: after })).state.leftover).toBe(true)
    expect(q.backspaces).toBe(0)
  })
  it('one that never reached the box is just dropped', async () => {
    const p = new FakePane()
    const r = await tick(p, { ...late(), enterOwed: false }, { nowMs: after })
    expect(r.state).toEqual(NOTHING_OWED)
    expect(p.submitted).toEqual([])
  })
})

describe('the Enter that may have answered a prompt (enter-check.ts; Pantheon on Fable R1-2 of the key-guard pair)', () => {
  /** A select opens between the guard's capture and the Enter, takes the Enter (the line stays), and is gone 300 ms later. */
  function swapping(): FakePane {
    const p = new FakePane()
    let afterEnter = 0
    p.sendEnterKey = async () => {
      afterEnter = 1
      p.dialog = true // the select is what took the key; the line is still in the box under it
      return 'sent' as const
    }
    const capture = p.visibleRowsEscaped.bind(p)
    p.visibleRowsEscaped = async () => {
      if (afterEnter === 1) {
        afterEnter = 2
        return capture() // right after: the select
      }
      if (afterEnter === 2) p.dialog = false // 300 ms later: answered and gone
      return capture()
    }
    return p
  }
  it('flagged, held, the classes kept for the audit; never a second Enter; it drops at its deadline', async () => {
    const p = swapping()
    let enters = 0
    const send = p.sendEnterKey
    p.sendEnterKey = async () => {
      enters++
      return send()
    }
    const r = await tick(p, owed())
    expect(r.delivered).toBe(false)
    expect(r.held).toBe('enter_uncertain')
    expect(r.enterCheck).toMatchObject({ flagged: true, why: 'line_still_in_box' })
    expect(r.enterCheck?.classes.pre).toBe('box_ours')
    expect(r.state.pending).toBe(true)
    // the next ticks: held, no Enter, nothing typed
    const again = await tick(p, r.state)
    expect(again.held).toBe('enter_uncertain')
    expect(enters).toBe(1)
    // kept across a supervisor restart too
    expect(persisted(r.state)).toMatchObject({ enter_uncertain: true })
    expect(restored(persisted(r.state)).enterUncertain).toBe(true)
  })
  it('a slow redraw (the line still drawn at once and 300 ms later, gone at 1000 ms) is delivered, not flagged (Fable R2-2b)', async () => {
    const p = new FakePane()
    let looksAfter = -1
    p.sendEnterKey = async () => {
      p.submitted.push(p.box)
      looksAfter = 0 // the line went in; the screen draws it two more looks
      return 'sent' as const
    }
    const capture = p.visibleRowsEscaped.bind(p)
    p.visibleRowsEscaped = async () => {
      if (looksAfter >= 0 && ++looksAfter > 2) p.box = ''
      return capture()
    }
    const r = await tick(p, owed())
    expect(looksAfter).toBe(3) // at once, 300 ms, 1000 ms
    expect(r.delivered).toBe(true)
    expect(r.enterCheck).toBeUndefined()
  })
  it('a clean submit is delivered as before (no flag, nothing held)', async () => {
    const r = await tick(new FakePane(), owed())
    expect(r.delivered).toBe(true)
    expect(r.enterCheck).toBeUndefined()
  })
})
