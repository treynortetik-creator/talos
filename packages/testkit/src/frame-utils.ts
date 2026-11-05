import { bindingFrom, type Card, type CardT, newId, newUlid, payloadHash } from '@talos-app/protocol'

export function now(): string {
  return new Date().toISOString()
}

/** Wraps fields in the frame envelope with a fresh id and timestamp. */
export function mkFrame<T extends string>(type: T, fields: Record<string, unknown> = {}, ts = now()) {
  return { v: 1 as const, type, id: newUlid(), ts, ...fields }
}

/**
 * How much longer a test waits for something it EXPECTS to happen (a frame, a notification, a condition). A pass is never
 * slower; only a failure takes longer to report. Real Chronos/bun/tmux child processes start 5-10x slower on a loaded CI box
 * (load 40+), so fixed 3-10 s budgets flaked without anything being wrong. Default 3; TALOS_TEST_WAIT_SCALE overrides.
 * Sleeps and product deadlines are not scaled, and neither is a wait that passes `exact`.
 */
export function waitScale(): number {
  const n = Number(process.env.TALOS_TEST_WAIT_SCALE)
  return Number.isFinite(n) && n >= 1 ? n : 3
}

export function waitFor(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const budget = timeoutMs * waitScale()
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - start > budget) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 5)
    }
    tick()
  })
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type CardInput = Partial<Omit<CardT, 'payload_hash' | 'state'>> & { thread_id: string }

/** Builds a valid pending Card with a correct payload_hash. */
export function buildCard(input: CardInput, at = new Date()): CardT {
  const base: CardT = {
    id: newId('c'),
    kind: 'generic',
    title: 'Example card',
    destination: [],
    body_format: 'plain',
    fields: [],
    attachments: [],
    primary_label: 'Approve',
    kill_label: 'Kill example',
    allow_edit: true,
    allow_revise: true,
    risk: 'low',
    origin: 'chat',
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: at.toISOString(),
    expires_at: new Date(at.getTime() + 86_400_000).toISOString(),
    ...input,
  }
  base.payload_hash = payloadHash(bindingFrom(base))
  return base
}

export type { Card }
