// Home banner (docs/V2-FEATURES.md V2.5): `mod_quiet`, a refused key, and `bridge_offline` outside the quiet window, each with
// its cause and next step (rows.ts macMessage). It polls on its own (60 s) so the shell can drop it anywhere. It reports what
// it shows to its parent so the presence banner next to it does not say the same thing twice (D40).
import { isQuiet } from '@talos-app/protocol'
import { useEffect, useLayoutEffect, useState } from 'react'
import { Link } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { bannerFor, type HealthBannerInfo } from './rows.ts'
import { fetchStatus } from './useHealthStatus.ts'

/** Cause on the first line, the next step under it. Shared by this banner and the presence banner. */
export function MacMessageText({ cause, next }: { cause: string; next: string }) {
  return (
    <div className="flex flex-1 flex-col gap-1">
      <span>{cause}</span>
      <span className="text-text-2">{next}</span>
    </div>
  )
}

export function HealthBanner({ onShowing }: { onShowing?: (kind: HealthBannerInfo['kind'] | null) => void }) {
  const on = useFeature('health/1') === 'on'
  const config = useTalos((s) => s.config)
  const [info, setInfo] = useState<HealthBannerInfo | null>(null)

  useEffect(() => {
    if (!on) return
    let alive = true
    const look = () =>
      fetchStatus().then(
        (s) => {
          const quiet = config ? isQuiet(new Date(), config.quiet_window, config.timezone) : false
          if (alive) setInfo(bannerFor(s, quiet))
        },
        () => {
          if (alive) setInfo(null)
        },
      )
    look()
    const t = setInterval(look, 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [on, config])

  const kind = info?.kind ?? null
  // layout effect: the presence banner steps aside before the screen paints, so there is never a frame with both
  useLayoutEffect(() => {
    onShowing?.(kind)
    return () => onShowing?.(null)
  }, [kind, onShowing])

  if (!info) return null
  return (
    <div
      role="status"
      data-testid="health-banner"
      data-kind={info.kind}
      className="flex items-start gap-3 bg-surface-2 px-4 py-2.5 text-sm"
    >
      <MacMessageText cause={info.text} next={info.next} />
      <Link to="/settings/health" className="shrink-0 font-semibold underline">
        Health
      </Link>
    </div>
  )
}
