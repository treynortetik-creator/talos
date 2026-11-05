// Platform adapter for the Mac app. It spreads `webPlatform` so every V3 addition (audio session, wake lock, media
// session, speech) keeps working, and overrides only what a web view hosted by an app does differently. This is the only
// code that turns a Platform call into a shell message (builder rule 9).
import type { Platform } from '../platform.ts'
import { webPlatform } from '../platform.ts'
import type { ShellBridge } from './bridge.ts'

/** A web view has no PushManager and no service-worker push: the shell shows notifications (features/native/notify.ts). */
const noPush: Platform['push'] = {
  permission: () => 'unsupported',
  subscribe: async () => null,
  unsubscribe: async () => {},
  resubscribe: async () => null,
}

export function createDesktopPlatform(bridge: ShellBridge): Platform {
  return {
    ...webPlatform,
    push: noPush,
    isIos: () => false,
    // https and mailto only, like the browser adapter (the protocol also allows http).
    openExternal: (url) => /^(https:\/\/|mailto:)/i.test(url) && bridge.send({ type: 'open_external', url }),
    haptic: () => {}, // the Mac has none
    installState: () => 'installed',
  }
}
