// Connects a detected shell to the running app: tells it the page is ready, mirrors the Needs-you count and the thread
// list, and handles what the shell sends (compose, navigate, enroll_code). Every handler validates again where it matters.
import type { TalosClient } from '../../lib/client.ts'
import { setMacNotifyPermission } from '../../lib/native/notifyPermission.ts'
import type { Shell } from '../../lib/native/shell.ts'
import { useSession } from '../auth/session.ts'
import { lastReplyText, startCompanionFeed } from './companion.ts'
import { startNativeNotify } from './notify.ts'

export const NATIVE_FEATURES = [
  'notify',
  'badge',
  'open_external',
  'compose',
  'navigate',
  'enroll_code',
  'companion/1',
] as const

/** The longest name the `threads` message carries (NativeThreads): a longer one would make the shell drop the whole list. */
const SHELL_NAME_MAX = 80

/** A thread's real name for the Mac shell: control characters out, ends trimmed, cut to 80 UTF-16 units on a character boundary; blank = "A thread". */
export function shellThreadName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  let out = ''
  for (const ch of clean) {
    if (out.length + ch.length > SHELL_NAME_MAX) break
    out += ch
  }
  out = out.trim()
  return out || 'A thread'
}

type Nav = (path: string) => void
/** Same-document navigation the router notices (it listens for popstate). */
const defaultNav: Nav = (path) => {
  history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
}

export function attachShell(shell: Shell, client: TalosClient, opts: { nav?: Nav; goto?: (url: string) => void } = {}) {
  const { bridge } = shell
  const nav = opts.nav ?? defaultNav
  const goto = opts.goto ?? ((url) => location.assign(url))
  const signedIn = () => useSession.getState().status === 'authed' && client.store.getState().devicePinned

  bridge.setHandlers({
    compose(m) {
      // Only a signed-in, pinned page sends; a shell cannot make a message appear before the Mac trusts this device.
      // Throwing makes `receive` answer false, which is how the Mac app's quick compose learns the message was NOT taken
      // and keeps the owner's text. The answer is the returned promise: true only once the message is signed and stored,
      // false if that failed (device key, storage write, a sign-out in between), so the owner's words are never cleared
      // for a message that is not saved.
      if (!signedIn()) throw new Error('not signed in')
      const text = m.text.trim()
      if (!text) throw new Error('empty message')
      return client.sendMessage({ threadId: m.thread_id, text }).then(() => {})
    },
    navigate(m) {
      nav(m.path)
    },
    companion_reply_request(m) {
      // Refused (receive answers false) when not signed in, like compose: the words of a reply never reach a shell that
      // has no session. The answer carries the request id back so the shell can tell a late answer from the current one.
      if (!signedIn()) throw new Error('not signed in')
      const r = lastReplyText(client.store.getState().messages, m.thread_id)
      bridge.send({ type: 'companion_reply', req: m.req, thread_id: m.thread_id, text: r.text, truncated: r.truncated })
    },
    notify_permission(m) {
      setMacNotifyPermission(m.state)
    },
    enroll_code(m) {
      // The code goes into the fragment like a pasted setup link; EnrollPage reads it from there.
      goto(`/enroll#${m.code}`)
    },
  })

  let lastSigned: boolean | null = null
  const ready = () => {
    const now = signedIn()
    if (now === lastSigned) return
    lastSigned = now
    bridge.send({ type: 'ready', shell_api: 1, features: [...NATIVE_FEATURES], signed_in: now })
  }

  let lastBadge = -1
  let lastThreads = ''
  // The shell hears about threads and the Needs-you count only while a session is signed in: after sign-out, or before
  // sign-in, it is told there are none (a cached store must not leak names or counts to the shell).
  const mirror = () => {
    ready()
    const st = client.store.getState()
    const live = useSession.getState().status === 'authed'
    const count = live
      ? st.cards.filter((c) => c.state === 'pending' && Date.parse(c.expires_at) > Date.now()).length
      : 0
    if (count !== lastBadge) {
      lastBadge = count
      bridge.send({ type: 'badge', count })
    }
    // The shell is the owner's own Mac app: the quick-compose picker and the companion's rows need the real names to be of
    // any use. `show_thread_names` is not applied here; it governs notifications (browser and phone), which the Mac shell
    // builds from fixed phrases and never from this list.
    const items = live
      ? st.threads
          .filter((t) => !t.archived && t.kind !== 'system')
          .map((t) => ({ id: t.id, name: shellThreadName(t.name) }))
          .slice(0, 100)
      : []
    const key = JSON.stringify(items)
    if (key !== lastThreads) {
      lastThreads = key
      bridge.send({ type: 'threads', items })
    }
  }
  mirror()
  const offSession = useSession.subscribe(mirror)
  const offStore = client.store.subscribe(mirror)
  const offNotify = startNativeNotify(client, bridge)
  const feed = startCompanionFeed(client, bridge)
  return () => {
    feed.stop()
    offSession()
    offStore()
    offNotify()
  }
}
