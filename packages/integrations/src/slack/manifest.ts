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
