import type { SetupSpecT } from '@talos-app/protocol'

export const SLACK_ASK_NOTE = 'Ask your IT team before connecting these.'

export const slackSetup: SetupSpecT = {
  id: 'slack',
  name: 'Slack',
  category: 'work',
  icon: 'slack',
  blurb: `Direct messages and mentions. Off until you turn it on. ${SLACK_ASK_NOTE}`,
  default_thread: 'work',
  filters: [
    { key: 'dms', label: 'Direct messages', default: true },
    { key: 'group_dms', label: 'Group direct messages', default: true },
    { key: 'mentions', label: 'Channel messages that mention you', default: true },
  ],
  connect: [
    {
      type: 'text',
      md: `**${SLACK_ASK_NOTE}** A workplace admin controls what apps may be added to a workspace. {agent} only keeps direct messages and messages that mention you; everything else is dropped before it is stored.`,
    },
    {
      type: 'text',
      md: '**1. Create the app.** Tap the button. Slack opens with everything filled in. Pick your workspace and tap **Create**.',
    },
    { type: 'link', label: 'Open Slack', href_template: '{{MANIFEST_URL}}' },
    {
      type: 'text',
      md: '**2. Turn it on.** In Slack open **App Manifest** and tap **Verify** next to the Request URL (it goes green). Then **Install to Workspace** and **Allow**. If Slack says "Request to install", an admin has to approve it.',
    },
    { type: 'copy', label: 'Request URL', value_template: '{{HOOK_URL}}', secret: false },
    {
      type: 'text',
      md: '**3. Paste one thing back:** the Signing Secret (Basic Information).',
    },
    {
      type: 'field',
      key: 'signing_secret',
      label: 'Signing Secret',
      secret: true,
      pattern: '^[0-9a-f]{32}$',
      help: 'On Basic Information, under App Credentials.',
    },
  ],
  test_hint: 'Send yourself a direct message from another account, or mention yourself in a channel.',
}
