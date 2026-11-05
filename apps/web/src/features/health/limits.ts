// The relay's own limits (BUFFER_DAYS, MEDIA_MAX_MB, voice minutes), read from GET /api/status `limits`. Copy that used to
// say "7 days" and "50 MB" as if they were fixed now says the real number, and falls back to exactly those old words when
// the relay is older and sends no `limits` (audit M34). One fetch per page load, shared by every caller.
import type { RelayLimitsT } from '@talos-app/protocol'
import { useEffect, useSyncExternalStore } from 'react'
import { fetchStatus } from './useHealthStatus.ts'

export type KnownLimits = {
  bufferDays?: number
  uploadMaxMb?: number
  voiceDailyMaxMin?: number
  voiceSessionMaxMin?: number
}

let known: KnownLimits = {}
let started = false
const subs = new Set<() => void>()
const emit = () => {
  for (const s of subs) s()
}

/** Called with every status the app fetches (Health polls it), so the numbers stay current without another request. */
export function noteLimits(limits: RelayLimitsT | undefined) {
  const next: KnownLimits = {
    ...(limits?.buffer_days !== undefined ? { bufferDays: limits.buffer_days } : {}),
    ...(limits?.upload_max_mb !== undefined ? { uploadMaxMb: limits.upload_max_mb } : {}),
    ...(limits?.voice_daily_max_min !== undefined ? { voiceDailyMaxMin: limits.voice_daily_max_min } : {}),
    ...(limits?.voice_session_max_min !== undefined ? { voiceSessionMaxMin: limits.voice_session_max_min } : {}),
  }
  if (JSON.stringify(next) === JSON.stringify(known)) return
  known = next
  emit()
}

/** The numbers known right now, for code that is not a component. */
export const getKnownLimits = (): KnownLimits => known

/** Test seam. */
export function resetLimits() {
  known = {}
  started = false
  emit()
}

/** The relay's limits, or `{}` while unknown (older relay, offline, not fetched yet): callers keep their old wording. */
export function useRelayLimits(fetchNow = true): KnownLimits {
  useEffect(() => {
    if (!fetchNow || started) return
    started = true
    fetchStatus().then(
      (s) => noteLimits(s.limits),
      () => {
        started = false // try again the next time something asks
      },
    )
  }, [fetchNow])
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    () => known,
    () => known,
  )
}

export const daysWord = (n: number | undefined): string =>
  n === undefined ? '7 days' : n === 1 ? '1 day' : `${n} days`
export const mbWord = (n: number | undefined): number => n ?? 50

/** "messages kept 7 days · uploads up to 50 MB · voice 60 min a day, 30 per call", or null when the relay sent none. */
export function limitsLine(l: RelayLimitsT | undefined): string | null {
  if (!l) return null
  const parts: string[] = []
  if (l.buffer_days !== undefined) parts.push(`messages kept ${daysWord(l.buffer_days)}`)
  if (l.upload_max_mb !== undefined) parts.push(`uploads up to ${l.upload_max_mb} MB`)
  if (l.voice_daily_max_min !== undefined || l.voice_session_max_min !== undefined) {
    const day =
      l.voice_daily_max_min === undefined
        ? null
        : l.voice_daily_max_min === 0
          ? 'no minutes allowed today'
          : `${l.voice_daily_max_min} min a day`
    const call = l.voice_session_max_min === undefined ? null : `${l.voice_session_max_min} min per call`
    parts.push(`live voice ${[day, call].filter(Boolean).join(', ')}`)
  }
  return parts.length ? parts.join(' · ') : null
}
