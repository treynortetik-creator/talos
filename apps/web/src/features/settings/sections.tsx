// Settings sections owned by WP6: Account, Notifications, Appearance (8.5). Connection moved into Health.
import type { RouteRes } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { onIphone } from '../../lib/confirmLabel.ts'
import { deleteDeviceKey } from '../../lib/deviceKey.ts'
import { createHttp, HttpError } from '../../lib/http.ts'
import { detectShell } from '../../lib/native/detect.ts'
import { type MacNotifyPermission, useMacNotifyPermission } from '../../lib/native/notifyPermission.ts'
import { isNativeShell } from '../../lib/native.ts'
import { passkeyErrorCopy } from '../../lib/passkeyGate.ts'
import { getPlatform } from '../../lib/platform.ts'
import { withStepup } from '../../lib/stepup.ts'
import { useStorage } from '../../lib/storageContext.tsx'
import { setTextSize, setTheme, type TextSize, type ThemeChoice, useTextSize, useTheme } from '../../lib/theme.ts'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Input, Switch } from '../../ui/index.ts'
import { ThreadIcon } from '../../ui/ThreadIcon.tsx'
import { clearLocalData, useSession } from '../auth/session.ts'
import { NativePushRow } from '../pwa/NativePushRow.tsx'
import { disablePush, enablePush, resubscribeOnOpen, sendTestPush, usePushState } from '../pwa/push.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { NOTIFY_LABEL } from '../threads/threadMeta.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { DeviceRow } from './DeviceRow.tsx'
import { ThemePicker } from './ThemePicker.tsx'
import { TrustModeSwitch } from './TrustModeSwitch.tsx'

const http = createHttp()
const FAKE = import.meta.env.VITE_FAKE === '1'
type Device = RouteRes<'devicesList'>[number]

export type SectionProps = { readOnly: boolean }

const H = ({ children }: { children: React.ReactNode }) => (
  <h2 className="m-0 mb-3 font-display text-xl font-semibold">{children}</h2>
)
const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line py-2">{children}</div>
)

// Revoking a device ends its device key and its sessions. A passkey is a separate thing: when another device signs in with the
// same one (a synced keychain), it stays valid for everyone who can unlock it.
const SHARED_PASSKEY_BEFORE =
  'This device shares its passkey with another device of yours. Revoking the device does not remove that passkey: it keeps working for the other device, and for anyone who can unlock it. To remove the passkey, revoke every device that uses it, then set them up again.'
const SHARED_PASSKEY_AFTER =
  'Revoked. Its passkey is shared with another device and still works. To remove the passkey, revoke every device that uses it, then set them up again.'

// ---- Account ------------------------------------------------------------------------------------------------------
export function AccountSection(_p: SectionProps) {
  const client = useTalosClient()
  const nav = useNavigate()
  const agent = useAgentName()
  // The device the relay attached to THIS session, not the key stored in the browser and never a name: it is what the
  // relay itself will act on (a revoke of this id ends this session).
  const myId = useSession((s) => s.me?.device_id ?? null)
  // Only for what must never be skipped: when the relay names no device (an older relay, or a cached `me` from before it
  // did), revoking the row that holds this browser's own key still confirms and signs this browser out. The "This device"
  // marker keeps using the relay's answer alone.
  const localId = useTalos((s) => s.deviceId)
  const config = useTalos((s) => s.config)
  const selfId = myId ?? localId
  const storage = useStorage()
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // The one confirmation open at a time: revoking THIS device, or signing out of every device.
  const [confirm, setConfirm] = useState<
    | { kind: 'revoke-self'; device: Device }
    | { kind: 'revoke-shared'; device: Device }
    | { kind: 'sign-out-all' }
    | { kind: 'sign-out-here' }
    | null
  >(null)
  // Shown after a revoke of a device whose passkey other devices still use: the passkey itself stays valid.
  const [sharedNotice, setSharedNotice] = useState(false)
  // The button that opened the confirmation: focus goes back to it when the dialog closes (the dialog has no trigger element).
  const opener = useRef<HTMLElement | null>(null)
  const load = useCallback(async () => {
    if (FAKE) {
      setDevices([])
      return
    }
    try {
      setDevices(await http.get<Device[]>('/api/devices'))
    } catch {
      setErr("Couldn't load your devices.")
    }
  }, [])
  useEffect(() => void load(), [load])

  /** This device is signed out for good: stop the client, empty what it cached, go to the sign-in page (audit D21). */
  const leaveThisDevice = async (opts: { dropDeviceKey: boolean }) => {
    client.close()
    // This browser stops taking Talos pushes: the relay keeps web-push subscriptions apart from sessions, so without this
    // a signed-out browser keeps showing notifications.
    await getPlatform()
      .push.unsubscribe()
      .catch(() => {})
    // A failed wipe must not keep the owner on a screen that looks signed in; the cache is rewritten at the next sign-in.
    await clearLocalData(storage).catch(() => {})
    if (opts.dropDeviceKey) await deleteDeviceKey(storage).catch(() => {})
    useSession.getState().setAnon()
    nav('/login')
  }
  const revoke = async (d: Device) => {
    setErr(null)
    setConfirm(null)
    setSharedNotice(false)
    try {
      await withStepup(client, config, 'device:revoke', (token) =>
        http.json('POST', `/api/devices/${d.id}/revoke`, token ? { stepup_token: token } : {}),
      )
    } catch (e) {
      setErr(passkeyErrorCopy(e) ?? "Couldn't revoke that device.")
      return
    }
    // Revoking this very device ends its session at the relay: leave, and drop the key the relay will never accept again.
    if (d.id === selfId) return void (await leaveThisDevice({ dropDeviceKey: true }))
    setSharedNotice(d.shared_passkey === true)
    await load()
  }
  // An already-ended session (401) is what sign-out wants anyway; any other failure means the relay still has it.
  const signOut = async (path: '/api/auth/logout' | '/api/auth/logout-all') => {
    setErr(null)
    setConfirm(null)
    try {
      if (!FAKE) {
        try {
          await http.json('POST', path)
        } catch (e) {
          // "Everywhere" is for devices the Mac has confirmed. A device still waiting for the Mac can only leave itself.
          if (path === '/api/auth/logout-all' && e instanceof HttpError && e.status === 403) {
            await http.json('POST', '/api/auth/logout')
          } else throw e
        }
      }
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 401)) {
        setErr("Couldn't sign out. Check your connection and try again.")
        return
      }
    }
    await leaveThisDevice({ dropDeviceKey: false })
  }
  return (
    <section aria-labelledby="acct" className="flex flex-col gap-4">
      <H>
        <span id="acct">Account</span>
      </H>
      <div>
        <h3 className="m-0 mb-1 text-base font-medium">Devices</h3>
        {devices === null && !err && <p className="m-0 text-text-2">Loading…</p>}
        {err && (
          <p role="alert" className="m-0 text-danger">
            {err}
          </p>
        )}
        {sharedNotice && (
          <p role="status" className="m-0 text-text-2">
            {SHARED_PASSKEY_AFTER}
          </p>
        )}
        {devices?.length === 0 && (
          <p className="m-0 text-text-2">{FAKE ? 'This is a demo device.' : 'No devices yet.'}</p>
        )}
        <ul className="m-0 list-none p-0">
          {devices?.map((d) => (
            <li key={d.id}>
              <DeviceRow
                device={d}
                isThisDevice={d.id === myId}
                onRevoke={(e) => {
                  opener.current = e.currentTarget
                  return d.id === selfId
                    ? setConfirm({ kind: 'revoke-self', device: d })
                    : d.shared_passkey
                      ? setConfirm({ kind: 'revoke-shared', device: d })
                      : void revoke(d)
                }}
              />
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="m-0 mb-1 text-base font-medium">Add a device</h3>
        <p className="m-0 text-text-2">
          Run <code>talos-app enroll</code> on your Mac and open the link on the new device. {agent} asks you to confirm
          the device there (y/N) before it can send anything.
        </p>
      </div>
      <div>
        <h3 className="m-0 mb-1 text-base font-medium">Trust mode</h3>
        <TrustModeSwitch />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          // On the iPhone app a signed-out phone can only come back through a new setup link from the Mac, so it asks first (U10)
          onClick={() => (onIphone() ? setConfirm({ kind: 'sign-out-here' }) : void signOut('/api/auth/logout'))}
        >
          Sign out of this device
        </Button>
        <Button variant="outline" onClick={() => setConfirm({ kind: 'sign-out-all' })}>
          Sign out everywhere
        </Button>
      </div>
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent
          aria-describedby="acct-confirm-desc"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            opener.current?.focus()
          }}
        >
          <DialogTitle className="text-lg font-medium text-text">
            {confirm?.kind === 'revoke-self'
              ? 'Revoke this device?'
              : confirm?.kind === 'revoke-shared'
                ? `Revoke ${confirm.device.name}?`
                : confirm?.kind === 'sign-out-here'
                  ? 'Sign out of this device?'
                  : 'Sign out everywhere?'}
          </DialogTitle>
          <DialogDescription id="acct-confirm-desc" className="mt-2 space-y-2 text-sm text-text-2">
            {confirm?.kind === 'revoke-shared' ? (
              <span className="block">{SHARED_PASSKEY_BEFORE}</span>
            ) : confirm?.kind === 'revoke-self' ? (
              <>
                <span className="block">You are on this device right now. Revoking it signs you out here.</span>
                {confirm.device.shared_passkey && <span className="block">{SHARED_PASSKEY_BEFORE}</span>}
                <span className="block">
                  To use it again, run <code>talos-app enroll</code> on your Mac and open the new link here.
                </span>
              </>
            ) : confirm?.kind === 'sign-out-here' ? (
              <>
                <span className="block">This signs this iPhone out and turns off its notifications.</span>
                <span className="block">
                  To sign back in you need a new setup link: run <code>talos-app enroll</code> on your Mac. Nothing is
                  deleted from your Mac.
                </span>
              </>
            ) : (
              <>
                <span className="block">
                  This signs out every phone, browser and Mac app you have set up, and turns off their notifications.
                </span>
                <span className="block">
                  Browsers sign back in with your passkey. The iPhone and Mac apps need a new setup link: run{' '}
                  <code>talos-app enroll</code> on your Mac. Nothing is deleted from your Mac.
                </span>
              </>
            )}
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm?.kind === 'revoke-self' || confirm?.kind === 'revoke-shared') void revoke(confirm.device)
                else if (confirm?.kind === 'sign-out-here') void signOut('/api/auth/logout')
                else void signOut('/api/auth/logout-all')
              }}
            >
              {confirm?.kind === 'sign-out-all'
                ? 'Sign out everywhere'
                : confirm?.kind === 'sign-out-here'
                  ? 'Sign out'
                  : 'Revoke this device'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ---- Notifications ------------------------------------------------------------------------------------------------
export function NotificationsSection({ readOnly }: SectionProps) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const threads = useTalos((s) => s.threads)
  const push = usePushState()
  const install = getPlatform().installState()
  const ios = getPlatform().isIos()
  const inShell = isNativeShell()
  const onMac = detectShell() === 'desktop'
  const macPermission = useMacNotifyPermission()
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    void resubscribeOnOpen()
  }, [])
  const patch = async (p: Record<string, unknown>) => {
    setNote(null)
    try {
      await client.patchConfig(p)
      return true
    } catch (e) {
      setNote(friendlyPatchError(e))
      return false
    }
  }
  return (
    <section aria-labelledby="notif" className="flex flex-col gap-3">
      <H>
        <span id="notif">Notifications</span>
      </H>
      {ios && install !== 'installed' && (
        <p className="m-0 rounded-card border border-line bg-surface p-3 text-sm">
          On iPhone, notifications work from the Home Screen app. Tap Share, then Add to Home Screen, and open it from
          there.
        </p>
      )}
      <Row>
        <span className="min-w-0">
          <label htmlFor="master" className="block">
            Chat notifications
          </label>
          <span className="block text-xs text-text-2">
            One switch for every device. Alarms about your Mac or the server still come through.
          </span>
        </span>
        <Switch
          id="master"
          checked={config?.notifications.master ?? true}
          disabled={readOnly || !config}
          onCheckedChange={(v) => void patch({ notifications: { master: v } })}
        />
      </Row>
      <QuietWindow readOnly={readOnly} onPatch={patch} />
      <div>
        <h3 className="m-0 mb-1 text-base font-medium">Per thread</h3>
        <p className="m-0 mb-2 text-sm text-text-2">Set in each thread's settings. Tap a thread to change it there.</p>
        <ul className="m-0 list-none p-0" data-testid="notify-summary">
          {threads
            .filter((t) => !t.archived)
            .map((t) => (
              <li key={t.id}>
                <Link
                  to={`/t/${t.id}?settings=1`}
                  className="flex min-h-11 items-center justify-between gap-3 border-b border-line py-2"
                >
                  <span className="min-w-0 truncate">
                    <ThreadIcon id={t.id} icon={t.icon} color={t.color} size={20} className="mr-1 align-text-bottom" />
                    {t.name}
                  </span>
                  <span className="shrink-0 text-sm text-text-2">
                    {NOTIFY_LABEL[t.notify]}
                    <span className="sr-only">. Open this thread's settings to change it.</span>
                  </span>
                </Link>
              </li>
            ))}
        </ul>
      </div>
      <Row>
        <label htmlFor="names">Show thread names</label>
        <select
          id="names"
          value={config?.notifications.show_thread_names ?? 'fixed_only'}
          disabled={readOnly || !config}
          onChange={(e) => void patch({ notifications: { show_thread_names: e.target.value } })}
          className="min-h-11 rounded-button border border-line bg-surface px-2"
        >
          <option value="fixed_only">Main threads</option>
          <option value="all">All threads</option>
          <option value="none">Never</option>
        </select>
      </Row>
      <p className="m-0 text-xs text-text-2">
        This changes browser notifications. iPhone notifications always show General and Inbox by name and call every
        other thread &ldquo;a thread&rdquo;, whatever it is set to.
      </p>
      {inShell ? (
        <NativePushRow />
      ) : onMac ? (
        <MacBannersRow permission={macPermission} />
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="m-0 text-base font-medium">Push on this device</h3>
          <p className="m-0 text-text-2" data-testid="push-status">
            {push.permission === 'granted'
              ? push.off
                ? 'Off'
                : 'On'
              : push.permission === 'denied'
                ? 'Blocked. Turn notifications back on in your device settings for this app.'
                : push.permission === 'unsupported'
                  ? 'Not supported here.'
                  : 'Off'}
          </p>
          {(push.permission === 'default' || (push.permission === 'granted' && push.off)) && (
            <Button onClick={() => void enablePush()} disabled={push.busy} className="self-start">
              Turn on notifications
            </Button>
          )}
          {push.permission === 'granted' && !push.off && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={async () =>
                  setNote(
                    (await sendTestPush())
                      ? 'Test sent. A test ignores the switch and thread rules above, so it can arrive while real notifications are off.'
                      : "Couldn't send the test.",
                  )
                }
              >
                Send a test notification
              </Button>
              <Button variant="outline" disabled={push.busy} onClick={() => void disablePush()}>
                Turn off
              </Button>
            </div>
          )}
          {push.message && <p className="m-0 text-sm text-text-2">{push.message}</p>}
        </div>
      )}
      {note && (
        <p role="status" className="m-0 text-sm text-text-2">
          {note}
        </p>
      )}
    </section>
  )
}

/**
 * Quiet hours (moved here from Settings -> Agent). Saves at once. They hold back pushes and Mac alerts between the two
 * times, in the timezone set under Agent.
 */
function QuietWindow({
  readOnly,
  onPatch,
}: {
  readOnly: boolean
  onPatch: (p: Record<string, unknown>) => Promise<boolean>
}) {
  const quiet = useTalos((s) => s.config?.quiet_window ?? null)
  const zone = useTalos((s) => s.config?.timezone ?? 'UTC')
  const ready = useTalos((s) => s.config !== null)
  const [times, setTimes] = useState<{ start: string; end: string } | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const start = times?.start ?? quiet?.start ?? '22:00'
  const end = times?.end ?? quiet?.end ?? '07:00'
  // Typing only edits the draft. A time is saved when the box is left (or Enter is pressed), never per keystroke:
  // every patch is signed against the revision on screen, so patches fired mid-typing would refuse each other and an
  // in-between value could be the one that stays. Saves also run one after another.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const latest = useRef(0)
  const inFlight = useRef('')
  const commit = (next: { start: string; end: string }) => {
    const valid = /^([01]\d|2[0-3]):[0-5]\d$/
    if (!valid.test(next.start) || !valid.test(next.end)) return
    if (next.start === next.end) return setIssue('Start and end must differ.')
    if (next.start === quiet?.start && next.end === quiet?.end) {
      setTimes(null)
      return setIssue(null)
    }
    setIssue(null)
    const key = `${next.start}-${next.end}`
    if (inFlight.current === key) return // Enter, then the blur that follows it: one save
    inFlight.current = key
    const mine = ++latest.current
    chain.current = chain.current.then(async () => {
      const ok = await onPatch({ quiet_window: next })
      if (inFlight.current === key) inFlight.current = ''
      // saved: follow the config again. Refused: go back to the saved times, never keep showing the unsaved ones.
      // Only if the boxes still show what was sent: a time typed since the save began stays, and is saved when left.
      if (mine === latest.current)
        setTimes((cur) => (cur && (cur.start !== next.start || cur.end !== next.end) ? cur : null))
      if (!ok) setIssue('Not saved. Check the times against what your Mac has.')
    })
  }
  const leave = () => times && commit(times)
  const turn = async (on: boolean) => {
    setIssue(null)
    setTimes(null)
    const ok = await onPatch({ quiet_window: on ? { start, end } : null })
    if (!ok) setIssue('Not saved.')
  }
  return (
    <div className="flex flex-col gap-2" data-testid="quiet-window">
      <Row>
        <span className="min-w-0">
          <label htmlFor="quiet-on" className="block">
            Quiet hours
          </label>
          <span className="block text-xs text-text-2">
            Holds back pushes and Mac alerts between these times ({zone}).
          </span>
        </span>
        <Switch
          id="quiet-on"
          checked={quiet !== null}
          disabled={readOnly || !ready}
          onCheckedChange={(v) => void turn(v)}
        />
      </Row>
      {quiet !== null && (
        <div className="flex items-center gap-2">
          <Input
            type="time"
            aria-label="Quiet hours start"
            disabled={readOnly}
            value={start}
            onChange={(e) => setTimes({ start: e.target.value, end })}
            onBlur={leave}
            onKeyDown={(e) => e.key === 'Enter' && leave()}
          />
          <span className="text-text-2">to</span>
          <Input
            type="time"
            aria-label="Quiet hours end"
            disabled={readOnly}
            value={end}
            onChange={(e) => setTimes({ start, end: e.target.value })}
            onBlur={leave}
            onKeyDown={(e) => e.key === 'Enter' && leave()}
          />
        </div>
      )}
      {issue && (
        <p role="alert" className="m-0 text-sm text-danger">
          {issue}
        </p>
      )}
    </div>
  )
}

const MAC_PERMISSION_TEXT: Record<MacNotifyPermission, string> = {
  unknown: 'Waiting for the Mac app to report the macOS setting. Update the Mac app if this stays.',
  granted: 'Allowed in macOS.',
  denied: 'Blocked. Turn Talos back on in System Settings > Notifications.',
  not_asked: 'Not asked yet. macOS asks the first time Talos has something to show.',
}
/** The Mac app shows its own banners (the web view has no push). Shown only while the Talos window isn't in front. */
function MacBannersRow({ permission }: { permission: MacNotifyPermission }) {
  return (
    <div className="flex flex-col gap-2" data-testid="mac-banners">
      <h3 className="m-0 text-base font-medium">Banners on this Mac</h3>
      <p className="m-0 text-text-2">Talos shows a banner when something needs you and its window isn't in front.</p>
      <p
        className={permission === 'denied' ? 'm-0 font-medium text-danger' : 'm-0 text-text-2'}
        data-testid="mac-banner-status"
        data-permission={permission}
      >
        {MAC_PERMISSION_TEXT[permission]}
      </p>
    </div>
  )
}

// ---- Appearance ---------------------------------------------------------------------------------------------------
const THEMES: Array<{ id: ThemeChoice; label: string }> = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]
const TEXT_SIZES: Array<{ id: TextSize; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'large', label: 'Large' },
  { id: 'larger', label: 'Larger' },
  { id: 'largest', label: 'Largest' },
]
export function AppearanceSection(p: SectionProps) {
  const theme = useTheme()
  const size = useTextSize()
  return (
    <section aria-labelledby="appearance" className="flex flex-col gap-3">
      <H>
        <span id="appearance">Appearance</span>
      </H>
      <div role="radiogroup" aria-label="Theme" className="flex gap-2">
        {THEMES.map((t) => (
          <Button
            key={t.id}
            role="radio"
            aria-checked={theme === t.id}
            variant={theme === t.id ? 'primary' : 'outline'}
            onClick={() => setTheme(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <ThemePicker readOnly={p.readOnly} />
      <h3 className="m-0 mt-2 text-base font-medium">Text size</h3>
      <div role="radiogroup" aria-label="Text size" className="flex flex-wrap gap-2">
        {TEXT_SIZES.map((t) => (
          <Button
            key={t.id}
            role="radio"
            aria-checked={size === t.id}
            variant={size === t.id ? 'primary' : 'outline'}
            onClick={() => setTextSize(t.id)}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <p className="m-0 text-sm text-text-2">Makes the whole app bigger or smaller on this device only.</p>
    </section>
  )
}
