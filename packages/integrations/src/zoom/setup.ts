import type { SetupSpecT } from '@talos-app/protocol'

export const zoomSetup: SetupSpecT = {
  id: 'zoom',
  name: 'Zoom',
  category: 'work',
  icon: 'video',
  blurb:
    'A note when a meeting recording is ready. Off until you turn it on. Ask your IT team before connecting these.',
  default_thread: 'work',
  filters: [{ key: 'recordings', label: 'Recording ready', default: true }],
  connect: [
    {
      type: 'text',
      md: '**Ask your IT team before connecting these.** This needs a Zoom Marketplace app with webhooks, and a workplace admin will most likely have to approve it. Until it is approved there is nothing to do here.',
    },
    {
      type: 'text',
      md: "**1.** In your Zoom app, add the event **Recording completed** and use the address below as the Event notification endpoint URL. **2.** Paste the app's Secret Token. **3.** Tap **Validate** in Zoom: it answers by itself.",
    },
    { type: 'copy', label: 'Event notification endpoint URL', value_template: '{{HOOK_URL}}', secret: false },
    { type: 'field', key: 'secret_token', label: 'Secret Token', secret: true, help: "On the app's Features page." },
  ],
  test_hint: 'Record a short meeting. The note arrives when Zoom finishes processing it.',
}
