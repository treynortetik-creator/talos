// Whether dictation can work on this relay. Served in GET /api/me so the app shows or hides the dictate button.
import type { RelayEnv } from '../env.ts'

export type DictateStatus = { available: boolean }

export function dictateStatus(env: Pick<RelayEnv, 'OPENAI_API_KEY' | 'DICTATE_DAILY_MAX_MB'>): DictateStatus {
  if (!env.OPENAI_API_KEY || env.DICTATE_DAILY_MAX_MB === 0) return { available: false }
  return { available: true }
}
