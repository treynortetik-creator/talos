// The one-click Slack app manifest (spec 7.5). Minimal scopes: history of DMs, group DMs and channels (a channel message
// matters only when it mentions the owner; the pre-filter drops the rest before storage). No `users:read` or other
// directory scopes: nothing here calls the Slack API with the token.
export const SLACK_USER_SCOPES = ['im:history', 'mpim:history', 'channels:history', 'groups:history'] as const
export const SLACK_USER_EVENTS = ['message.im', 'message.mpim', 'message.channels', 'message.groups'] as const

export function slackManifest(requestUrl: string) {
  return {
    display_information: { name: 'Talos Inbox' },
    features: { bot_user: { display_name: 'talos-inbox' } },
    oauth_config: { scopes: { user: [...SLACK_USER_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: requestUrl, user_events: [...SLACK_USER_EVENTS] },
      socket_mode_enabled: false,
    },
  }
}

/** `https://api.slack.com/apps?new_app=1&manifest_json=<urlencoded>`; `requestUrl` is `https://<host>/hook/slack/<cn>`. */
export function slackManifestUrl(requestUrl: string): string {
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    throw new Error('requestUrl is not a URL')
  }
  if (u.protocol !== 'https:') throw new Error('Slack needs an https request URL')
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest(requestUrl)))}`
}

// The bot app's manifest (an agent's bot, "Create a new bot app"). Bot scopes only: the history of DMs, group DMs and
// channels the bot is in, and chat:write, which Slack requires for the App Home Messages tab (without it people cannot DM
// the bot). Talos never sees the bot token (only the Signing Secret), so it can never post as the bot.
export const SLACK_BOT_SCOPES = ['im:history', 'mpim:history', 'channels:history', 'chat:write'] as const
export const SLACK_BOT_EVENTS = ['message.im', 'message.mpim', 'message.channels'] as const

export function slackBotManifest(requestUrl: string) {
  return {
    display_information: { name: 'Talos Agent' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'talos-agent', always_online: false },
    },
    oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES] } },
    settings: {
      event_subscriptions: { request_url: requestUrl, bot_events: [...SLACK_BOT_EVENTS] },
      socket_mode_enabled: false,
    },
  }
}

/** The "Create a new bot app" link: like `slackManifestUrl`, with the bot app's manifest. */
export function slackBotManifestUrl(requestUrl: string): string {
  slackManifestUrl(requestUrl) // the same https check
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackBotManifest(requestUrl)))}`
}
