// The driving toggle (docs/V2-FEATURES.md V4.1): one signed `config.patch {voice_notes:{driving_until}}`.
//   On = now + 2 h; off = null. On `config_conflict` (another device changed the config) wait for the new config,
//   then retry once. A second failure says so in plain words.
import { DRIVING_DEFAULT_MS, DRIVING_REEXTEND_MS, drivingActive } from '@talos-app/protocol'
import { useCallback, useEffect, useState } from 'react'
import { type TalosClient, TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { getDrive } from './instance.ts'

export const DRIVING_FAILED = "Couldn't change driving mode. Try again."

/** `superseded`: another device turned driving off while we were retrying an auto-extend; we did not undo it. */
export type SetDrivingResult = { ok: true } | { ok: false; message: string; superseded?: true }

export async function setDriving(
  client: Pick<TalosClient, 'patchConfig' | 'store'>,
  on: boolean,
  opts: { now?: number; retryDelayMs?: number; onlyIfActive?: boolean } = {},
): Promise<SetDrivingResult> {
  const now = opts.now ?? Date.now()
  const patch = { voice_notes: { driving_until: on ? new Date(now + DRIVING_DEFAULT_MS).toISOString() : null } }
  try {
    await client.patchConfig(patch)
    return { ok: true }
  } catch (e) {
    if (!(e instanceof TalosClientError) || e.code !== 'config_conflict') return { ok: false, message: DRIVING_FAILED }
  }
  await waitForNewRev(client, opts.retryDelayMs ?? 600)
  // An auto-extend must never bring back driving that another device just turned off.
  if (opts.onlyIfActive) {
    const cfg = client.store.getState().config
    if (!cfg || !drivingActive(cfg, Date.now())) return { ok: false, message: DRIVING_FAILED, superseded: true }
  }
  try {
    await client.patchConfig(patch)
    return { ok: true }
  } catch {
    return { ok: false, message: DRIVING_FAILED }
  }
}

/** The `config.sync` that caused the conflict usually lands within a moment; do not wait longer than `ms`. */
function waitForNewRev(client: Pick<TalosClient, 'store'>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  const rev = client.store.getState().config?.rev
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const unsub = client.store.subscribe((s) => {
      if (s.config?.rev !== rev) done()
    })
    const timer = setTimeout(done, ms)
  })
}

/** True and the expiry while `driving_until` is in the future. Flips to false by itself when the time is up. */
export function useDrivingState(): { active: boolean; until: number | null; reextendDue: boolean } {
  const until = useTalos((s) => s.config?.voice_notes.driving_until ?? null)
  const [, tick] = useState(0)
  const t = until ? Date.parse(until) : Number.NaN
  useEffect(() => {
    if (!Number.isFinite(t)) return
    const left = t - Date.now()
    if (left <= 0) return
    const h = setTimeout(() => tick((n) => n + 1), Math.min(left + 50, 2 ** 31 - 1))
    return () => clearTimeout(h)
  }, [t])
  const active =
    until !== null && drivingActive({ voice_notes: { reply_with_voice: 'never', driving_until: until } }, Date.now())
  return { active, until: Number.isFinite(t) ? t : null, reextendDue: active && t - Date.now() < DRIVING_REEXTEND_MS }
}

/**
 * Turning driving on from a tap: unlocks the shared audio element in the same gesture (before any await), then patches
 * the config. `toggle` is the one entry used by Settings and /drive.
 */
export function useDrivingToggle() {
  const client = useTalosClient()
  const { active } = useDrivingState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = useCallback(
    async (on: boolean) => {
      setError(null)
      const d = on ? getDrive(client) : null
      if (d) {
        void d.queue.unlock()
        d.controller.touch()
        // This device's tap turned driving on: it is the one that reads replies aloud.
        d.controller.claim()
      }
      setBusy(true)
      const r = await setDriving(client, on)
      setBusy(false)
      if (!r.ok) {
        d?.controller.unclaim()
        setError(r.message)
      }
      return r.ok
    },
    [client],
  )
  return { active, busy, error, set }
}
