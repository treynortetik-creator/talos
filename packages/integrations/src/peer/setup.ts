import type { SetupSpecT } from '@talos-app/protocol'

/**
 * Linked agents (docs: peer.ts in the protocol package). Listed so the id has a setup entry, with nothing to connect from the app:
 * a peer inbox is made only by the Mac's signed route on the relay (`POST /bridge/peers`), never by the app's wizard.
 */
export const peerSetup: SetupSpecT = {
  id: 'peer',
  name: 'Linked agent',
  category: 'personal',
  icon: 'link',
  blurb: 'Lets your other Talos install send messages to this one. Not available yet.',
  default_thread: 'inbox',
  filters: [],
  connect: [{ type: 'text', md: 'Not available yet.' }],
  test_hint: 'Not available yet.',
}
