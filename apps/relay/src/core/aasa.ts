// Apple App Site Association for the iPhone shell (IOS-SPEC WP-I6). Served at /.well-known/apple-app-site-association so a
// WKWebView under an app with the Associated Domains entitlement (`webcredentials:<RP_ID host>`) may use the SAME passkeys
// the browser uses. Same RP ID, same origin, same step-up: this file only says "this app may use credentials for this host".
//
// It reuses APNS_TEAM_ID and APNS_BUNDLE_ID (the app's identity is the same for push and for passkeys). Inert unless both
// are set and well-formed: the route then answers 404, exactly as before this feature.

export type AasaEnv = { APNS_TEAM_ID?: string | undefined; APNS_BUNDLE_ID?: string | undefined }

const TEAM_ID = /^[A-Z0-9]{10}$/
const BUNDLE_ID = /^[A-Za-z0-9.-]{3,155}$/

/** The `webcredentials` document, or null when the team or bundle id is missing or malformed. */
export function aasaDocument(env: AasaEnv): { webcredentials: { apps: string[] } } | null {
  const team = env.APNS_TEAM_ID
  const bundle = env.APNS_BUNDLE_ID
  if (!team || !bundle || !TEAM_ID.test(team) || !BUNDLE_ID.test(bundle)) return null
  return { webcredentials: { apps: [`${team}.${bundle}`] } }
}
