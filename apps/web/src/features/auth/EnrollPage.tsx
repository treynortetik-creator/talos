// `/enroll#code` (spec 8.2, 5.3). Two halves: passkey, then the device key bound to the code. The code lives in the URL
// fragment only. On iOS outside the Home Screen app the code is NOT consumed: the page offers [Copy setup link].
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { createHttp } from '../../lib/http.ts'
import { inShell } from '../../lib/native/shell.ts'
import { getPlatform } from '../../lib/platform.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import { Button, Input } from '../../ui/index.ts'
import { Mascot, type MascotState } from '../../ui/Mascot.tsx'
import { EnrollError, parseSetupLink, runEnrollment } from './passkeys.ts'
import { useSession } from './session.ts'

type Step =
  | { kind: 'ios-install' }
  | { kind: 'paste'; error?: string }
  | { kind: 'ready' }
  | { kind: 'running' }
  | { kind: 'confirm'; words: string[]; deviceId: string }
  | { kind: 'timeout'; words: string[]; deviceId: string }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'error'; message: string }
  | { kind: 'done' }

const http = createHttp()

/**
 * How long the phone waits for the Mac's y/N before it says so (audit D56). The setup link itself lives 10 minutes; this
 * is the point where "still waiting" stops being a good answer and the person needs to know what to check.
 */
export const CONFIRM_WAIT_MS = 90_000

function Card({ mascot, title, children }: { mascot: MascotState; title: string; children?: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-4 incised rounded-card bg-surface p-7 text-center">
        <Mascot state={mascot} size={112} decorative />
        <h1 className="m-0 font-display text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  )
}

export function EnrollPage() {
  const nav = useNavigate()
  const client = useTalosClient() as Partial<SocketClient> & ReturnType<typeof useTalosClient>
  const agent = useTalos((s) => s.config?.agent.name) ?? 'Talos'
  const platform = getPlatform()
  const ios = platform.isIos()
  const installed = platform.installState() === 'installed'
  const shell = inShell()
  const [code, setCode] = useState<string | null>(() => parseSetupLink(location.hash))
  const [pasted, setPasted] = useState('')
  const [copied, setCopied] = useState(false)
  const [step, setStep] = useState<Step>(() => {
    if (ios && !installed) return { kind: 'ios-install' }
    return parseSetupLink(location.hash) ? { kind: 'ready' } : { kind: 'paste' }
  })

  const start = async (c: string) => {
    if (!client.ensureDevice) return setStep({ kind: 'error', message: 'This build cannot enroll.' })
    setStep({ kind: 'running' })
    try {
      const { words, deviceId } = await runEnrollment(c, client as SocketClient)
      setStep({ kind: 'confirm', words, deviceId })
      void (client as SocketClient).start({ pinned: false })
    } catch (e) {
      if (e instanceof EnrollError) {
        if (e.kind === 'expired') return setStep({ kind: 'expired' })
        if (e.kind === 'cancelled') return setStep({ kind: 'ready' })
        if (e.kind === 'invalid_link') return setStep({ kind: 'paste', error: e.message })
        return setStep({ kind: 'error', message: e.message })
      }
      setStep({ kind: 'error', message: 'Setup failed.' })
    }
  }

  // After the device key is registered, wait for the Mac's y/N (device.pinned) with /api/me as a fallback. After
  // CONFIRM_WAIT_MS the screen turns into the timeout state, but we keep listening: a late "y" still finishes setup.
  const deviceId = step.kind === 'confirm' || step.kind === 'timeout' ? step.deviceId : null
  const timedOut = step.kind === 'timeout'
  useEffect(() => {
    if (!deviceId) return
    let alive = true
    const finish = async (ok: boolean) => {
      if (!alive) return
      if (!ok) return setStep({ kind: 'denied' })
      client.setPinned?.(true)
      await useSession.getState().refresh()
      setStep({ kind: 'done' })
      setTimeout(() => nav('/', { replace: true }), 1500)
    }
    const off = client.onFrame('device.pinned', (f) => {
      if (f.device_id === deviceId) void finish(f.ok)
    })
    const poll = setInterval(async () => {
      try {
        const me = await http.get<{ device_pinned: boolean }>('/api/me')
        if (me.device_pinned) void finish(true)
      } catch {}
    }, 3000)
    const giveUp = timedOut
      ? undefined
      : setTimeout(() => {
          setStep((s) => (s.kind === 'confirm' ? { kind: 'timeout', words: s.words, deviceId: s.deviceId } : s))
        }, CONFIRM_WAIT_MS)
    return () => {
      alive = false
      off()
      clearInterval(poll)
      if (giveUp) clearTimeout(giveUp)
    }
  }, [deviceId, timedOut, client, nav])

  const copyLink = async () => {
    const ok = await platform.clipboard.write(location.href)
    setCopied(ok)
  }
  const paste = async (text: string | null) => {
    const c = text ? parseSetupLink(text) : null
    if (!c) return setStep({ kind: 'paste', error: "That doesn't look like a setup link." })
    setCode(c)
    await start(c)
  }

  switch (step.kind) {
    case 'ios-install':
      return (
        <Card mascot="pleased" title={`Add ${agent} to your Home Screen first`}>
          <p className="m-0 text-text-2">
            A Home Screen app keeps its own passkey and device key, so set it up there. Your setup link has not been
            used yet.
          </p>
          <ol className="m-0 w-full list-decimal pl-6 text-left">
            <li>Tap Copy setup link below.</li>
            <li>
              Tap the Share button in Safari, then <strong>Add to Home Screen</strong>.
            </li>
            <li>Open {agent} from your Home Screen and tap Paste setup link.</li>
          </ol>
          {code && (
            <Button onClick={() => void copyLink()} className="w-full">
              {copied ? 'Copied' : 'Copy setup link'}
            </Button>
          )}
        </Card>
      )
    case 'paste':
      return (
        <Card mascot="pleased" title={`Set up ${agent} on this device`}>
          <p className="m-0 text-text-2">
            Run <code>talos-app enroll</code> on your Mac, copy the link it prints, then paste it here.
          </p>
          <Button className="w-full" onClick={async () => paste(await platform.clipboard.read())}>
            Paste setup link
          </Button>
          <form
            className="flex w-full flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void paste(pasted)
            }}
          >
            <label htmlFor="link" className="text-left text-sm text-text-2">
              Or type the link or code
            </label>
            <Input
              id="link"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button type="submit" variant="outline">
              Continue
            </Button>
          </form>
          {step.error && (
            <p role="alert" className="m-0 text-danger">
              {step.error}
            </p>
          )}
        </Card>
      )
    case 'ready':
      return (
        <Card mascot="pleased" title={`Set up ${agent} on this device`}>
          <p className="m-0 text-text-2">
            {shell
              ? 'This setup link signs you in, then your Mac asks you to confirm this device.'
              : 'You will create a passkey, then your Mac asks you to confirm this device.'}
          </p>
          <Button className="w-full" onClick={() => code && void start(code)}>
            {shell ? 'Continue' : ios ? 'Continue with Face ID' : 'Continue with passkey'}
          </Button>
        </Card>
      )
    case 'running':
      return (
        <Card mascot="working" title="Setting up…">
          <p role="status" className="m-0 text-text-2">
            Follow the prompt on this device.
          </p>
        </Card>
      )
    case 'confirm':
      return (
        <Card mascot="pleased" title="Check your Mac">
          <p className="m-0 text-text-2">Confirm these four words at the prompt in your terminal:</p>
          <p className="m-0 font-mono text-lg font-semibold" data-testid="fingerprint">
            {step.words.join(' ')}
          </p>
          <p role="status" className="m-0 text-sm text-text-2">
            Waiting for your Mac to confirm this device.
          </p>
        </Card>
      )
    case 'timeout':
      return (
        <Card mascot="worried" title="Your Mac has not answered">
          <p className="m-0 text-text-2">
            Nothing on your Mac has confirmed the words{' '}
            <span className="font-mono font-semibold" data-testid="fingerprint">
              {step.words.join(' ')}
            </span>{' '}
            yet. This device is already waiting on your Mac, so the link you scanned is used up; only your Mac saying
            yes finishes it from here.
          </p>
          <ol className="m-0 w-full list-decimal pl-6 text-left text-text-2">
            <li>
              Look at the terminal where you ran <code>talos-app enroll</code>. If it asks <code>[y/N]</code>, check the
              four words and type <strong>y</strong>.
            </li>
            <li>
              If that terminal is closed, run <code>talos-app enroll --confirm</code> on your Mac.
            </li>
            <li>
              If your Mac is asleep or Claude is not running there, wake it and run <code>talos-app start</code>, then{' '}
              <code>talos-app enroll</code> again for a new link.
            </li>
          </ol>
          <p role="status" className="m-0 text-sm text-text-2">
            This page keeps listening and finishes by itself once your Mac says yes.
          </p>
          <Button variant="outline" className="w-full" onClick={() => setStep({ kind: 'paste' })}>
            Start over with a new link
          </Button>
        </Card>
      )
    case 'done':
      return (
        <Card mascot="beaming" title="This device is ready">
          <p role="status" className="m-0 text-text-2">
            Taking you to {agent}…
          </p>
        </Card>
      )
    case 'denied':
      return (
        <Card mascot="worried" title="Your Mac said no to this device">
          <p role="alert" className="m-0 text-text-2">
            Run <code>talos-app enroll</code> again if this was a mistake.
          </p>
        </Card>
      )
    case 'expired':
      return (
        <Card mascot="worried" title="This link expired">
          <p role="alert" className="m-0 text-text-2">
            This link expired. Run <code>talos-app enroll</code> on your Mac for a fresh one.
          </p>
        </Card>
      )
    case 'error':
      return (
        <Card mascot="worried" title="Something went wrong">
          <p role="alert" className="m-0 text-text-2">
            {step.message}
          </p>
          <Button variant="outline" onClick={() => setStep(code ? { kind: 'ready' } : { kind: 'paste' })}>
            Try again
          </Button>
        </Card>
      )
  }
}
