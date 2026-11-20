// Settings -> Voice: the driving mode toggle and its preferences (docs/V2-FEATURES.md V4.1).
import { useState } from 'react'
import { Link, useInRouterContext } from 'react-router'
import { useFeature } from '../../lib/v2Client.ts'
import { Switch } from '../../ui/index.ts'
import { useWriteBlock } from '../settings/offline.ts'
import { useDrivingState, useDrivingToggle } from './driving.ts'
import { loadPhoneVoiceFallback, savePhoneVoiceFallback } from './prefs.ts'

const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-11 items-center justify-between gap-3">{children}</div>
)

export function DrivingRow({ readOnly }: { readOnly: boolean }) {
  const feature = useFeature('driving/1')
  const block = useWriteBlock()
  const { set, busy, error } = useDrivingToggle()
  const { active, until } = useDrivingState()
  const [phoneVoice, setPhoneVoice] = useState(loadPhoneVoiceFallback)
  const inRouter = useInRouterContext()
  const off = feature === 'off'
  const disabled = readOnly || busy || block !== null || off
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" data-testid="driving-row" aria-label="Driving mode">
      <Row>
        <label htmlFor="driving-mode" className="text-base">
          Driving mode
        </label>
        <Switch id="driving-mode" checked={active} disabled={disabled} onCheckedChange={(v) => void set(v)} />
      </Row>
      <p className="m-0 text-sm text-text-2">
        {off
          ? 'Your Mac needs the latest Talos update for driving mode.'
          : block === 'mac' // not connected: the settings screen says so once, above the section
            ? 'Your Mac is offline, so this can’t be changed right now.'
            : active && until
              ? `On until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Every reply is sent as text and read to you. Keep Talos open on screen.`
              : 'Every reply comes as text at once and is read to you a moment later. Turns itself off after 2 hours.'}
      </p>
      {error && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
      {inRouter && (
        <Link to="/drive" className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text underline">
          Open the driving screen
        </Link>
      )}
      <Row>
        <label htmlFor="driving-phone-voice" className="text-sm">
          Use the phone’s voice as a fallback
        </label>
        <Switch
          id="driving-phone-voice"
          checked={phoneVoice}
          onCheckedChange={(v) => {
            setPhoneVoice(v)
            savePhoneVoiceFallback(v)
          }}
        />
      </Row>
    </fieldset>
  )
}
