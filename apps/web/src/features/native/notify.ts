// Native notifications for the Mac app. The web view has no push, so while the window is not in front the page turns the
// frames it receives into a `notify` message. The text comes from `buildPushPayload` (fixed phrases only), the same
// builder the relay's push uses, so a reply's words can never reach the notification (docs/SECURITY.md, push privacy).
import { type AgentConfigT, buildPushPayload, isQuiet, type PushIntent } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import type { ShellBridge } from '../../lib/native/bridge.ts'

export type NativeNotification = { title: string; body: string; navigate: string; tag?: string }

/** The relay's rules for chat pushes (core/push.ts): master switch, quiet window, per-thread setting. */
export function nativeNotification(
  intent: PushIntent,
  config: AgentConfigT | null,
  now: Date,
): NativeNotification | null {
  if (!config) return null
  if (!config.notifications.master) return null
  if (isQuiet(now, config.quiet_window, config.timezone)) return null
  const thread = intent.thread_id ? config.threads.find((t) => t.id === intent.thread_id) : undefined
  if (thread?.notify === 'off') return null
  if (thread?.notify === 'needs_you' && intent.template !== 'needs_you') return null
  const { notification } = buildPushPayload(intent, config)
  const out: NativeNotification = {
    title: notification.title,
    body: notification.body,
    navigate: notification.navigate,
  }
  if (notification.tag) out.tag = notification.tag
  return out
}

/** The page is not what the owner is looking at (hidden, or the window is not key). */
export const pageIsBackground = (): boolean =>
  typeof document !== 'undefined' && (document.visibilityState !== 'visible' || !document.hasFocus())

export function startNativeNotify(
  client: TalosClient,
  bridge: ShellBridge,
  opts: { background?: () => boolean; now?: () => Date } = {},
): () => void {
  const background = opts.background ?? pageIsBackground
  const now = opts.now ?? (() => new Date())
  const emit = (intent: PushIntent) => {
    if (!background()) return
    const n = nativeNotification(intent, client.store.getState().config, now())
    if (n) bridge.send({ type: 'notify', ...n })
  }
  const offs = [
    client.onFrame('reply', (f) => {
      // A send that went out without a card (its kind is always allowed): like the relay's push, it ignores the quiet window,
      // the master switch and thread alerts, so nothing is sent unseen. Fixed words; it opens the thread with the line.
      if (f.sent_always_allowed === true && !f.silent) {
        // shown with the window in front too, like the relay's push (which goes to a visible app as well): the owner may be
        // reading another thread
        const cfg = client.store.getState().config
        if (!cfg) return
        const { notification } = buildPushPayload(
          { template: 'sent_always_allowed', thread_id: f.message.thread_id },
          cfg,
        )
        bridge.send({
          type: 'notify',
          title: notification.title,
          body: notification.body,
          navigate: notification.navigate,
        })
        return
      }
      // A reply spoken to a live voice call, or marked silent, never makes a banner.
      if (f.silent || f.voice_delegation_id) return
      if (f.message.author !== 'agent') return
      emit({ template: 'reply', thread_id: f.message.thread_id })
    }),
    client.onFrame('card.create', (f) =>
      emit({ template: 'needs_you', thread_id: f.card.thread_id, card_id: f.card.id }),
    ),
  ]
  return () => {
    for (const off of offs) off()
  }
}
