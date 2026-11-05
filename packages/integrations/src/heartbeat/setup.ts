import type { SetupSpecT } from '@talos-app/protocol'

/**
 * Heartbeat is not an inbound integration. It is listed here only because turning on work content for Heartbeat uses the same
 * owner-signed switch as every work integration (`config.work.enabled`, passkey step-up). Nothing connects and nothing arrives.
 */
export const heartbeatSetup: SetupSpecT = {
  id: 'heartbeat',
  name: 'Heartbeat (work items)',
  category: 'work',
  icon: 'heart',
  blurb: 'Lets Heartbeat show short titles from work systems. Off until you turn it on.',
  default_thread: 'work',
  filters: [],
  connect: [
    {
      type: 'text',
      md: 'There is nothing to connect. Turning this on only lets Heartbeat sources marked **work** post a short title in your work thread.',
    },
  ],
  test_hint: 'The next Heartbeat check shows any work items it finds.',
}
