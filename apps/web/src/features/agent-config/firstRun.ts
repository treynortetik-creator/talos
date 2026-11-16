// First run: after the agent's first device is paired on an agent never set up (device.pinned `first`, judged by the
// bridge from its device history and the agent folder; the client keeps it as `firstPin`), the app opens the Setup thread
// and sends the kickoff itself, once.
// "Once per agent" is the Setup thread itself: when one exists that this first run did not make, archived or not, first
// run does nothing, so a second phone, a Skip or a reinstall never starts it again. The kickoff goes through startSetup,
// which makes one thread and one kickoff however many starts race (two phones, a Settings tap). The card offers Skip.
// Kept in sessionStorage across a reload: `pending` (heard `first`, nothing done yet), then `started` (this first run made
// the Setup thread; a kickoff that failed is sent again), and the card while it shows.
import { create } from 'zustand'
import type { TalosClient } from '../../lib/client.ts'
import { onFirstPin } from '../../lib/firstPin.ts'
import { SETUP_THREAD_ID, startSetup } from './setupThread.ts'

const KEY = 'talos.firstRun'
const CARD_KEY = 'talos.firstRunCard'
type Stage = 'pending' | 'started' | null

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, v)
  } catch {
    // no storage (a private window): this lives in memory only
  }
}
const storedStage = (): Stage => {
  const v = read(KEY)
  return v === 'pending' || v === 'started' ? v : null
}

type FirstRun = {
  stage: Stage
  /** First run opened the Setup thread: it shows the first-run card until Skip. */
  card: boolean
}
export const useFirstRun = create<FirstRun>(() => ({ stage: storedStage(), card: read(CARD_KEY) === '1' }))

function setStage(stage: Stage) {
  write(KEY, stage)
  useFirstRun.setState({ stage })
}
export function setCard(card: boolean) {
  write(CARD_KEY, card ? '1' : null)
  useFirstRun.setState({ card })
}

/** The bridge said `first` for this device: first run is to happen. */
export function markFirstRun(): void {
  if (useFirstRun.getState().stage === null) setStage('pending')
}
onFirstPin(markFirstRun)

/** Ready to decide: pinned, online, and the agent's config (with its threads) is in. */
export function firstRunReady(client: TalosClient): boolean {
  const s = client.store.getState()
  return s.devicePinned && s.connection === 'online' && s.config !== null
}

const running = new WeakMap<TalosClient, Promise<boolean>>()

/**
 * Runs first run for `client` if it is due: true when it opened the Setup thread (the caller navigates there). A failure
 * (offline, refused) keeps it due, and the next ready moment tries again.
 */
export function runFirstRun(client: TalosClient): Promise<boolean> {
  const inFlight = running.get(client)
  if (inFlight) return inFlight
  const run = (async () => {
    const stage = useFirstRun.getState().stage
    if (stage === null) return false
    const there = client.store.getState().threads.some((t) => t.id === SETUP_THREAD_ID)
    // a Setup thread this first run did not make: another phone's, or an earlier one. Nothing to do, ever.
    if (there && stage === 'pending') {
      setStage(null)
      return false
    }
    if (!there) setStage('started') // before the thread exists: from here on, the thread is this run's own
    await startSetup(client) // one thread, and the kickoff only if none is waiting for an answer
    setStage(null)
    setCard(true)
    return true
  })()
  running.set(client, run)
  const clear = () => {
    if (running.get(client) === run) running.delete(client)
  }
  run.then(clear, clear)
  return run
}

/** Tests only. */
export function resetFirstRun(): void {
  write(KEY, null)
  write(CARD_KEY, null)
  useFirstRun.setState({ stage: null, card: false })
}
