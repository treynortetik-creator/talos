// Web push wiring. Permission is requested ONLY from a tap (`enablePush`); every open re-subscribes an existing grant
// without prompting. The platform adapter does all PushManager work (builder rule 9).
import { create } from 'zustand'
import { createHttp } from '../../lib/http.ts'
import { getPlatform, type PushPermission } from '../../lib/platform.ts'

const http = createHttp()
const FAKE = import.meta.env.VITE_FAKE === '1'

export async function getVapidKey(): Promise<string | null> {
  const env = import.meta.env.VITE_VAPID_PUBLIC_KEY
  if (typeof env === 'string' && env) return env
  try {
    const me = await http.get<{ vapid_public_key?: string }>('/api/me')
    return me.vapid_public_key ?? null
  } catch {
    return null
  }
}

// "Turn off" on this device. The browser keeps permission granted after an unsubscribe, so permission alone cannot say
// whether the owner switched push off: without this flag the next open's resubscribe would quietly turn it back on, and the
// status line would still read On. Per device (localStorage), cleared by `enablePush`.
const OFF_KEY = 'talos.push.off'
export function isPushOff(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === '1'
  } catch {
    return false
  }
}
function setPushOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1')
    else localStorage.removeItem(OFF_KEY)
  } catch {
    // storage blocked: the switch-off still happens this session, it just may not survive a reload
  }
}

type PushState = {
  permission: PushPermission
  /** The owner turned push off on this device (see OFF_KEY). */
  off: boolean
  busy: boolean
  message: string | null
  refresh(): void
}
export const usePushState = create<PushState>((set) => ({
  permission: 'default',
  off: isPushOff(),
  busy: false,
  message: null,
  refresh() {
    set({ permission: getPlatform().push.permission(), off: isPushOff() })
  },
}))

/** Tap handler for "Turn on notifications". The only place that can show the permission prompt. */
export async function enablePush(): Promise<void> {
  const st = usePushState
  st.setState({ busy: true, message: null })
  try {
    const key = await getVapidKey()
    if (!key) {
      st.setState({ message: 'Notifications are not set up on your server yet.' })
      return
    }
    const sub = await getPlatform().push.subscribe(key)
    if (sub) setPushOff(false) // only a real subscription clears the switch-off
    st.getState().refresh()
    if (!sub) {
      st.setState({ message: 'Notifications are off for this app.' })
      return
    }
    await http.json('POST', '/api/push/subscribe', sub)
    st.setState({ message: 'Notifications are on.' })
  } catch {
    st.setState({ message: "Couldn't turn notifications on." })
  } finally {
    st.setState({ busy: false })
  }
}

/**
 * Tap handler for "Turn off": this browser stops taking pushes, here and at the relay, and stays off across opens.
 * The switch-off flag is set only once the browser has really dropped its subscription. Before that a failure leaves the
 * subscription (and the pushes) alive, so the row must still read On and keep the Turn off button.
 */
export async function disablePush(): Promise<void> {
  const st = usePushState
  st.setState({ busy: true, message: null })
  let endpoint: string | null = null
  try {
    // The endpoint has to be read before the browser drops the subscription; the platform adapter hands it over via resubscribe.
    const key = await getVapidKey()
    const sub = key ? await getPlatform().push.resubscribe(key) : null
    endpoint = sub?.endpoint ?? null
    await getPlatform().push.unsubscribe()
  } catch {
    st.setState({ message: "Couldn't turn notifications off. Try again.", busy: false })
    return
  }
  setPushOff(true)
  st.getState().refresh()
  try {
    if (endpoint && !FAKE) await http.json('DELETE', '/api/push/subscribe', { endpoint })
    st.setState({ message: 'Notifications are off on this device.' })
  } catch {
    // Off on this device for good; the relay drops a dead endpoint on its next push, so there is nothing to retry here.
    st.setState({ message: "Turned off on this device. The server hasn't confirmed yet and will stop on its own." })
  } finally {
    st.setState({ busy: false })
  }
}

export async function sendTestPush(): Promise<boolean> {
  try {
    await http.json('POST', '/api/push/test', {})
    return true
  } catch {
    return false
  }
}

/** The iPhone row's test: asks about the phone alone, so a browser that took the push cannot hide Apple's refusal. */
export async function sendNativeTest(h: { json: typeof http.json } = http): Promise<boolean> {
  try {
    await h.json('POST', '/api/push/test?via=apns', {})
    return true
  } catch {
    return false
  }
}

/** On every open: if permission is already granted, refresh the subscription (no prompt). */
export async function resubscribeOnOpen(): Promise<void> {
  usePushState.getState().refresh()
  if (FAKE || isPushOff() || getPlatform().push.permission() !== 'granted') return
  const key = await getVapidKey()
  if (!key) return
  const sub = await getPlatform().push.resubscribe(key)
  if (sub) await http.json('POST', '/api/push/subscribe', sub).catch(() => {})
}
