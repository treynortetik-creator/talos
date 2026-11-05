// Small formatting helpers (no locale or timezone assumptions: the browser's own).
export function relativeTime(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return ''
  const diff = Math.max(0, nowMs - Date.parse(iso))
  const s = Math.round(diff / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  return `${d} d`
}

/** Row-trailing age with no space or "ago": "now", "4m", "3h", "3d". Empty for a missing or unreadable time. */
export function shortAge(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor(Math.max(0, nowMs - t) / 1000)
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dayLabel(iso: string, nowMs: number = Date.now()): string {
  const d = new Date(iso)
  const today = new Date(nowMs)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  const y = new Date(nowMs)
  y.setDate(y.getDate() - 1)
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** "just now", "3 min ago", "2 h ago". */
export function ago(iso: string | null | undefined, nowMs: number = Date.now()): string {
  const r = relativeTime(iso, nowMs)
  return r === 'now' || r === '' ? 'just now' : `${r} ago`
}
