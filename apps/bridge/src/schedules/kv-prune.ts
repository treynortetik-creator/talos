// Two small kv rows are kept for thread sessions' schedule work: who proposed a card, and which session started a run. Both are
// only useful while the card waits or the run is open, so they go when the card resolves, expires or is replaced and when the
// run closes. A crash or a headless process can skip that, so the bridge also sweeps at start: a row goes when its card or run
// is over, unknown, or older than a week.

export const CARD_PROPOSER_PREFIX = 'schedule_card_proposer/'
export const RUN_STARTED_PREFIX = 'schedule_run_started/'
export const KV_MAX_AGE_MS = 7 * 24 * 3600_000

export const proposerKey = (cardId: string) => `${CARD_PROPOSER_PREFIX}${cardId}`
export const startedKey = (runId: string) => `${RUN_STARTED_PREFIX}${runId}`

export type KvPruneDeps = {
  now: number
  kv: { kvKeys(prefix: string): string[]; kvDelete(key: string): void }
  /** The card's state and creation time, or undefined when no such card exists. */
  card: (id: string) => { state: string; created_at: string } | undefined
  /** The run's in-flight entry, or undefined when none is kept. */
  run: (id: string) => { closed?: string | undefined; claimed_at: number } | undefined
}

/** Returns how many rows it removed. Never throws: a row it cannot judge stays for the next start. */
export function pruneScheduleKv(d: KvPruneDeps): number {
  let n = 0
  const drop = (key: string) => {
    try {
      d.kv.kvDelete(key)
      n++
    } catch {
      // stays for the next start
    }
  }
  for (const key of d.kv.kvKeys(CARD_PROPOSER_PREFIX)) {
    const c = d.card(key.slice(CARD_PROPOSER_PREFIX.length))
    const made = c ? Date.parse(c.created_at) : Number.NaN
    // a card still waiting (or approved and being applied) keeps its row; anything else is over
    const live = c !== undefined && (c.state === 'pending' || c.state === 'resolved')
    if (!live || (Number.isFinite(made) && d.now - made > KV_MAX_AGE_MS)) drop(key)
  }
  for (const key of d.kv.kvKeys(RUN_STARTED_PREFIX)) {
    const r = d.run(key.slice(RUN_STARTED_PREFIX.length))
    if (!r || r.closed || d.now - r.claimed_at > KV_MAX_AGE_MS) drop(key)
  }
  return n
}
