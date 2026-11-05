import { detectShell } from '../../lib/native/detect.ts'
import { isNativeShell } from '../../lib/native.ts'
import { Button } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { Meander } from '../../ui/Meander.tsx'

export type RecoveryKind = 'opening' | 'storage' | 'wipe'

function body(kind: RecoveryKind, wipeMode: 'all' | 'keep' | null, where: Where): { title: string; text: string } {
  // A browser can be held up by another Talos tab; the iPhone and Mac apps have no tabs, and Try again reuses the stuck open.
  const first = where === 'browser' ? 'close other Talos tabs' : 'restart the app'
  if (kind === 'opening') {
    return {
      title: 'Still opening Talos storage…',
      text: `This device has not answered yet. It may still finish. If it never does, ${first} and try again, or clear this device's data (below).`,
    }
  }
  if (kind === 'wipe') {
    return wipeMode === 'keep'
      ? {
          title: "Talos couldn't finish clearing this device",
          text: 'Your session ended, and some saved chats could not be removed from this device. Your unsent messages are kept. Try again to remove the chats.',
        }
      : {
          title: "Talos couldn't finish clearing this device",
          text: 'You signed out here, but some saved chats or unsent messages could not be removed from this device. Talos will not send or show them. Try again to remove them.',
        }
  }
  return {
    title: "Talos can't open its storage",
    text: `This device would not let Talos read what it saved. Nothing was deleted. Try again, ${where === 'browser' ? 'close other Talos tabs and restart the app' : 'restart the app'}, or clear this device's data (below).`,
  }
}

export type Where = 'browser' | 'iphone' | 'mac'

/** Which Talos this is, from what the page can see: the iPhone app, the Mac app, or any browser. */
export function whereAmI(scope: unknown = globalThis): Where {
  return isNativeShell(scope) ? 'iphone' : detectShell(scope) === 'desktop' ? 'mac' : 'browser'
}

const DELETES =
  "This deletes unsent messages, voice notes, chats saved on this device and this device's key. You will sign in and pair this device again."

function clearSteps(where: Where): string[] {
  if (where === 'iphone') return ['Delete the Talos app from your iPhone, then install it again.', DELETES]
  if (where === 'mac')
    return [
      'In the Talos menu bar app, choose Forget this Mac. It also revokes this Mac, so you need a new setup code afterwards.',
      DELETES,
    ]
  return [
    'This affects every Talos tab in this browser, so close Talos in every other tab and window first.',
    "Clear this site's data in your browser's settings (look for site data, or cookies and site data, for this site), then open Talos again.",
    DELETES,
  ]
}

/**
 * Shown while the device's own storage is opening for longer than the owner expects (`opening`: no answer yet, so no timer
 * decides when this appears), when it refused (`storage`) or when a sign-out's wipe could not finish (`wipe`). Try again
 * starts again: on the first two it deletes nothing, on the wipe screen it runs the wipe that was owed. Talos never deletes the device database itself: a delete the page asks for may wait behind other tabs,
 * and whether it is still alive after the page closes depends on the browser, so the page cannot know what it did. The way
 * out of a permanent failure is the instructions below, which the owner carries out in their browser or on their device.
 */
export function StorageRecovery({
  kind,
  wipeMode = null,
  where = whereAmI(),
  onRetry,
}: {
  kind: RecoveryKind
  wipeMode?: 'all' | 'keep' | null
  where?: Where
  onRetry: () => void
}) {
  const { title, text } = body(kind, wipeMode, where)
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-6">
      <div className="flex max-w-[360px] flex-col items-center gap-4 text-center">
        <Mascot state="worried" size={120} name="Talos" decorative />
        <h1 className="m-0 font-display text-2xl font-semibold">{title}</h1>
        <Meander className="w-32" />
        <p className="m-0 text-text-2" role={kind === 'opening' ? 'status' : 'alert'}>
          {text}
        </p>
        <Button onClick={onRetry} autoFocus>
          Try again
        </Button>
        <section className="flex flex-col gap-2 text-sm text-text-2" aria-labelledby="clear-device">
          <h2 id="clear-device" className="m-0 text-base font-semibold text-text">
            Last resort: clear this device's data
          </h2>
          {clearSteps(where).map((line) => (
            <p key={line} className="m-0">
              {line}
            </p>
          ))}
        </section>
      </div>
    </main>
  )
}
