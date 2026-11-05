// Redaction for `talos-app report` and `talos-app logs`: text that leaves the Mac must carry no key, token or code.
// It is a net, not a proof: the report tells the owner to read it before sharing.

export type RedactOptions = {
  /** Folders to show as `~` / `$TALOS_APP_HOME` instead of the real path (the user's name is in them). */
  userHome?: string
  appHome?: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function redact(text: string, o: RedactOptions = {}): string {
  let t = text
  // longest folder first, so $TALOS_APP_HOME (usually under ~) wins
  if (o.appHome) t = t.replace(new RegExp(escapeRe(o.appHome.replace(/\/+$/, '')), 'g'), '$TALOS_APP_HOME')
  if (o.userHome && o.userHome.length > 1) t = t.replace(new RegExp(escapeRe(o.userHome.replace(/\/+$/, '')), 'g'), '~')
  return (
    t
      // auth headers first, scheme and credential together, so the generic rule below cannot eat only the scheme
      .replace(/(TalosBridge\s+)\S+/gi, '$1[redacted]')
      .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
      // the public key line `doctor` prints (BRIDGE_PUBKEY_FORCE=1 is a switch, not a secret)
      .replace(/(BRIDGE_PUBKEY\s*=\s*)[A-Za-z0-9_+/-]{20,}={0,2}/g, '$1[redacted]')
      // Basic auth: the credential follows the scheme word, so it needs its own rule before the generic one
      .replace(/(authorization["']?\s*[:=]\s*["']?basic\s+)[^\s"',}]+/gi, '$1[redacted]')
      // any assignment whose name contains a secret word: BOT_TOKEN=, client_secret=, "access_token":, x-api-key:
      .replace(
        /([A-Za-z0-9_.-]*(?:authorization|token|secret|passw(?:or)?d|cookie|pkcs8|enroll_code|setup_code|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',}]+/gi,
        '$1[redacted]',
      )
      // a setup link: the code lives in the fragment
      .replace(/(\/enroll#)\S+/g, '$1[redacted]')
      // a numeric id, a colon and a long token
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[redacted]')
      // anything that looks like a key or token: 32+ URL-safe or base64 characters in a row (a path has slashes, so it is safe)
      .replace(/[A-Za-z0-9_+-]{32,}={0,2}/g, '[redacted]')
  )
}
