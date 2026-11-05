// Keeps this device's colours in step with the owner's config: the stock theme chosen on any device arrives here and is
// applied. Renders nothing. Also repaints when the system light/dark switches, because a stock theme's tokens are inline.
import { useEffect } from 'react'
import { useTalos } from '../../lib/client.ts'
import {
  applyTheme,
  isStockThemeApplied,
  setStockTheme,
  stockThemeFromConfig,
  stockThemeResetActive,
} from '../../lib/theme.ts'

export function ThemeSync() {
  const loaded = useTalos((s) => s.config !== null && s.config !== undefined)
  const theme = useTalos((s) => s.config?.theme)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyTheme()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  useEffect(() => {
    if (!loaded) return
    if (stockThemeResetActive()) return // reset on this device: show talos until the owner picks again
    const id = stockThemeFromConfig(theme)
    if (!isStockThemeApplied(id)) setStockTheme(id)
  }, [loaded, theme])
  return null
}
