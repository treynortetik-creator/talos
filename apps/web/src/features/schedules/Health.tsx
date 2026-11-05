// The scheduler health banner and its fix sheet (docs/SCHEDULES.md S5.5), plus the Mac-offline banner (S5.6).
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Button, Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { COPY, fill } from './constants.ts'
import type { Banner } from './logic.ts'
import { refusalWords, Ticks } from './shared.tsx'
import { refreshSchedules } from './sync.ts'

export function OfflineBanner({ asOf }: { asOf: string | null }) {
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="flex items-center gap-3 bg-surface-2 px-4 py-2.5 text-sm"
    >
      <Mascot state="worried" size={24} decorative animate={false} />
      <span className="flex-1">
        {asOf ? fill(COPY.offline, { time: asOf }) : 'Your Mac is offline. Changes and Run now need your Mac.'}
      </span>
    </div>
  )
}

export function HealthBanner({ banner, onNotice }: { banner: Banner; onNotice: (t: string) => void }) {
  const client = useTalosClient()
  const nav = useNavigate()
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const [fixOpen, setFixOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const label =
    banner.button === 'resume'
      ? 'Resume'
      : banner.button === 'review'
        ? 'Review'
        : banner.button === 'show'
          ? 'Show'
          : 'How to fix'
  const press = async () => {
    if (banner.button === 'fix') return setFixOpen(true)
    if (banner.button === 'resume') {
      setBusy(true)
      try {
        await client.schedules.controlSchedule('resume_all', null)
      } catch (e) {
        onNotice(refusalWords(e))
      } finally {
        setBusy(false)
      }
      return
    }
    // the scheduler names a job when it can; otherwise the first one in that state
    const rows = client.store.getState().schedules.snapshot?.schedules ?? []
    const want = banner.button === 'review' ? 'held' : 'missed'
    const id = banner.scheduleId ?? rows.find((r) => r.today === want)?.id
    if (id) nav(`/schedules/${id}`)
  }
  return (
    <>
      <div
        role="status"
        data-testid="health-banner"
        data-issue={banner.code}
        className="flex items-center gap-3 border-b border-line bg-surface-2 px-4 py-2.5 text-sm"
      >
        <Mascot state="worried" size={24} decorative animate={false} />
        <span className="min-w-0 flex-1">{banner.text}</span>
        <Button variant="outline" disabled={busy || (banner.button === 'resume' && !macOnline)} onClick={press}>
          {label}
        </Button>
      </div>
      <FixSheet banner={banner} open={fixOpen} onOpenChange={setFixOpen} onNotice={onNotice} />
    </>
  )
}

export function FixSheet({
  banner,
  open,
  onOpenChange,
  onNotice,
}: {
  banner: Banner
  open: boolean
  onOpenChange: (o: boolean) => void
  onNotice: (t: string) => void
}) {
  const client = useTalosClient()
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const retry = async () => {
    setBusy(true)
    setResult(null)
    try {
      await client.schedules.controlSchedule('retry_headless', null)
      setResult('Sent. Your Mac is testing background runs now. The banner updates when it knows.')
      setConfirming(false)
      void refreshSchedules(client)
    } catch (e) {
      const w = refusalWords(e)
      setResult(w)
      onNotice(w)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setConfirming(false)
          setResult(null)
        }
      }}
    >
      <SheetContent aria-describedby="fix-desc" data-testid="fix-sheet">
        <SheetTitle className="font-display text-lg font-semibold">How to fix</SheetTitle>
        <SheetDescription id="fix-desc" className="mt-1 text-sm text-text-2">
          {banner.text}
        </SheetDescription>
        {banner.fixIntro ? <p className="mt-3 text-md">{banner.fixIntro}</p> : null}
        {banner.fix && banner.fix.length > 0 ? (
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-md">
            {banner.fix.map((step) => (
              <li key={step}>
                <Ticks text={step} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-3 text-md">Your scheduler didn't say how to fix this. Check it on your Mac.</p>
        )}
        {banner.retry ? (
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            {confirming ? (
              <>
                <p className="text-sm">
                  This starts one tiny Claude run in the background to test it. It makes no changes.
                </p>
                <div className="flex gap-2">
                  <Button disabled={busy || !macOnline} onClick={retry}>
                    Start the test
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="outline" disabled={!macOnline} onClick={() => setConfirming(true)}>
                Retry background runs
              </Button>
            )}
            {result ? (
              <p role="status" className="text-sm text-text-2">
                {result}
              </p>
            ) : null}
          </div>
        ) : null}
        <SheetClose className="mt-3 min-h-11 text-sm text-text-2 underline">Close</SheetClose>
      </SheetContent>
    </Sheet>
  )
}
