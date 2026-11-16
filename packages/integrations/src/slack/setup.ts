import type { SetupSpecT } from '@talos-app/protocol'

type SetupStep = SetupSpecT['connect'][number]

export const SLACK_ASK_NOTE = 'Ask your IT team before connecting these.'

const SIGNING_SECRET_FIELD: SetupStep = {
  type: 'field',
  key: 'signing_secret',
  label: 'Signing Secret',
  secret: true,
  pattern: '^[0-9a-f]{32}$',
  help: 'On Basic Information, under App Credentials.',
}

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
    SIGNING_SECRET_FIELD,
  ],
  test_hint: 'Send yourself a direct message from another account, or mention yourself in a channel.',
}

// ---- an agent's bot (identity 'bot') ---------------------------------------------------------------------------------
// The wizard shows these instead of the owner's wording when "An agent's bot" is picked. The connection is the same
// Slack integration; only the words, the manifest and the two ways of step 3 differ.

export const slackBot = {
  title: 'What should reach the bot?',
  blurb: `Messages people send to your agent's Slack bot. The bot's own posts are ignored. ${SLACK_ASK_NOTE}`,
  filtersLegend: 'Reach the agent for',
  filterLabels: {
    dms: 'Direct messages to the bot',
    group_dms: 'Group direct messages with the bot',
    mentions: 'Channel messages that mention the bot',
  } as Record<string, string>,
  threadNote:
    'Pick the thread of the agent that answers as this bot. Talos reads which bot it is from Slack, so there is nothing extra to paste.',
  intro: [
    {
      type: 'text',
      md: `**${SLACK_ASK_NOTE}** A workplace admin controls what apps may be added to a workspace. {agent} only keeps direct messages to the bot, group direct messages with it and channel messages that mention it; everything else is dropped before it is stored. The bot only hears public channels it has been added to.`,
    },
  ] as SetupStep[],
  ways: [
    {
      title: 'Add to a bot app you already have',
      steps: [
        {
          type: 'text',
          md: "**1. Send its events here.** In the app's settings on api.slack.com open **Event Subscriptions**, turn it on and paste this Request URL (it goes green).",
        },
        {
          type: 'text',
          md: '**An app has one Request URL for all its events.** If this app already sends its events somewhere else, pasting this one sends them here instead. Check before you change it.',
        },
        { type: 'copy', label: 'Request URL', value_template: '{{HOOK_URL}}', secret: false },
        {
          type: 'text',
          md: '**2. Subscribe to bot events** `message.im`, `message.mpim` and `message.channels`, and save.',
        },
        {
          type: 'text',
          md: '**3. Check the scopes.** Under **OAuth & Permissions** the bot needs `im:history`, `mpim:history` and `channels:history`, and `chat:write` for the Messages tab if the app does not post already. If Slack asks you to reinstall the app, do.',
        },
        {
          type: 'text',
          md: '**4. Let people message it.** Under **App Home** switch on the **Messages Tab** and allow messages from it.',
        },
        {
          type: 'text',
          md: "**5. Add the bot to channels** it should hear: in each channel, type `/invite` and the bot's name.",
        },
      ] as SetupStep[],
    },
    {
      title: 'Create a new bot app',
      steps: [
        {
          type: 'text',
          md: '**1. Create the app.** Tap the button. Slack opens with everything filled in. Pick your workspace and tap **Create**.',
        },
        { type: 'link', label: 'Open Slack', href_template: '{{BOT_MANIFEST_URL}}' },
        {
          type: 'text',
          md: '**2. Turn it on.** In Slack open **App Manifest** and tap **Verify** next to the Request URL (it goes green). Then **Install to Workspace** and **Allow**. If Slack says "Request to install", an admin has to approve it.',
        },
        { type: 'copy', label: 'Request URL', value_template: '{{HOOK_URL}}', secret: false },
        {
          type: 'text',
          md: "**3. Add the bot to channels** it should hear: in each channel, type `/invite` and the bot's name.",
        },
      ] as SetupStep[],
    },
  ],
  after: [
    { type: 'text', md: "**Then paste one thing back:** the app's Signing Secret (Basic Information)." },
    SIGNING_SECRET_FIELD,
  ] as SetupStep[],
  test_hint: 'Send the bot a direct message from your account, or mention it in a channel it is in.',
} as const
