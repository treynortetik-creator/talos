// Redaction for `talos-app report` and `talos-app logs`, and for the bug reporter (in the app, and the relay's webhook): text
// that leaves the Mac or the relay must carry no key, token or code.
// It is a net, not a proof: the report tells the owner to read it before sharing.

export type RedactOptions = {
  /** Folders to show as `~` / `$TALOS_APP_HOME` instead of the real path (the user's name is in them). */
  userHome?: string
  appHome?: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Names whose value is a secret: BOT_TOKEN=, client_secret=, "access_token":, x-api-key:, db_password = ... */
const SECRET_NAME =
  '[A-Za-z0-9_.-]*(?:authorization|token|secret|passw(?:or)?d|cookie|pkcs8|enroll_code|setup_code|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_-]*'
/** An AWS access key id (long-term AKIA, temporary ASIA). */
const AWS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g

/**
 * An AWS secret access key on its own is 40 characters with slashes, so neither its name nor the 32-character rule (which
 * stops at a slash, to keep paths) catches it. It is redacted bare only on a line that also carries an access key id: a CSV
 * export or a pasted credential pair, never an ordinary path.
 */
function awsPairs(t: string): string {
  return t
    .split('\n')
    .map((line) =>
      line.search(AWS_KEY_ID) < 0
        ? line
        : line
            .replace(AWS_KEY_ID, '[redacted]')
            .replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g, '[redacted]'),
    )
    .join('\n')
}

/**
 * A query-string parameter name that carries a secret: token, secret, password, api key, signature and the like, with any
 * prefix or suffix (x-api-key, refresh_token, X-Amz-Signature). The long words match inside a name; the short ones that sit
 * inside ordinary words (key in keyboard, code in codec, auth in author) only as a whole word between - _ . separators.
 */
const QUERY_SECRET_NAME =
  '(?:[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|signature)[A-Za-z0-9_.-]*|(?:key|code)|(?:[A-Za-z0-9]+[_.-])*(?:sig|pwd|auth|session(?:[_-]?id)?)(?:[_.-][A-Za-z0-9]+)*)'

/**
 * Splits a command line into the parts a shell runs separately (; && || | newline), keeping the separators. A separator inside
 * single or double quotes (or after a backslash) is part of a value, not a split.
 */
function splitCommands(t: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string
    if (c === '\\' && q !== "'" && i + 1 < t.length) {
      cur += c + t[++i]
      continue
    }
    if (q) {
      if (c === q) q = ''
      cur += c
    } else if (c === '"' || c === "'") {
      q = c
      cur += c
    } else if (c === ';' || c === '\n' || c === '|' || (c === '&' && t[i + 1] === '&')) {
      const sep = (c === '|' || c === '&') && t[i + 1] === c ? c + c : c // || and && are one separator
      i += sep.length - 1
      out.push(cur, sep)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}
// the tool word at the start of a part or after a space, with any path in front (/usr/bin/curl, ./curl)
const HTTP_TOOL = /(?:^|[\s(])(?:[^\s"']*\/)?(?:curl|wget|http|https)\s/
const USER_FLAG = /(?<![\w-])(-u\s*|--user[=\s]\s*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"']+)/g

/**
 * -u / --user on a curl, wget or http command (not docker's or ssh's): user:password keeps the user and drops the password;
 * with no colon it is a bare user and stays; an empty user or an empty password drops the whole value (an API key is often
 * the user, `-u sk_live_x:`). A quoted value is taken whole.
 */
function redactUserFlags(t: string): string {
  return splitCommands(t)
    .map((part) =>
      !HTTP_TOOL.test(part)
        ? part
        : part.replace(USER_FLAG, (m, flag: string, value: string) => {
            const q = value[0] === '"' || value[0] === "'" ? value[0] : ''
            const inner = q ? value.slice(1, value.endsWith(q) && value.length > 1 ? -1 : undefined) : value
            const colon = inner.indexOf(':')
            if (colon < 0 || inner === '[redacted]') return m
            const user = inner.slice(0, colon)
            const pass = inner.slice(colon + 1)
            if (pass === '[redacted]') return m
            return `${flag}${q}${user && pass ? `${user}:[redacted]` : '[redacted]'}${q}`
          }),
    )
    .join('')
}

export function redact(text: string, o: RedactOptions = {}): string {
  let t = text
  // longest folder first, so $TALOS_APP_HOME (usually under ~) wins
  if (o.appHome) t = t.replace(new RegExp(escapeRe(o.appHome.replace(/\/+$/, '')), 'g'), '$TALOS_APP_HOME')
  if (o.userHome && o.userHome.length > 1) t = t.replace(new RegExp(escapeRe(o.userHome.replace(/\/+$/, '')), 'g'), '~')
  return (
    redactUserFlags(awsPairs(t))
      // a password in a URL (scheme://user:password@host): the user and the host stay, so the report still says where
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[redacted]@')
      // a secret in a query string (?key=..&x=1): the name and the rest of the query stay. Before the generic rule below, which
      // would run on to the next space and eat the following parameters and the fragment.
      .replace(new RegExp(`([?&]${QUERY_SECRET_NAME}=)(?!\\[redacted\\])[^&#\\s"']+`, 'gi'), '$1[redacted]')
      // --password / --pass / --token with a space or = before the value (quoted values may hold spaces)
      .replace(
        /(--(?:password|pass|token)(?:=|\s+))(?!\[redacted\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)/gi,
        '$1[redacted]',
      )
      // auth headers first, scheme and credential together, so the generic rule below cannot eat only the scheme
      .replace(/(TalosBridge\s+)\S+/gi, '$1[redacted]')
      .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
      // the public key line `doctor` prints (BRIDGE_PUBKEY_FORCE=1 is a switch, not a secret)
      .replace(/(BRIDGE_PUBKEY\s*=\s*)[A-Za-z0-9_+/-]{20,}={0,2}/g, '$1[redacted]')
      // Authorization with ANY scheme word (Basic, Token, Digest, Zapier-Key...): the credential follows the scheme, to the end
      // of the header value (Digest's is a list of quoted pairs)
      .replace(/(authorization["']?\s*[:=]\s*["']?[A-Za-z][\w-]*\s+)[^\n"']*(?:"[^"\n]*"[^\n"']*)*/gi, '$1[redacted]')
      // a Cookie header holds many secrets (`a=1; b=2`): the whole value goes, not only the first pair
      .replace(/((?:set-)?cookie["']?\s*:\s*)(?!\[redacted\])[^\n"]+/gi, '$1[redacted]')
      // a quoted secret value may hold spaces ("correct horse battery staple"): everything between the quotes goes
      .replace(
        new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)(["'])(?!\\[redacted\\])[^"'\\n]*\\2`, 'gi'),
        '$1$2[redacted]$2',
      )
      // an unquoted password runs to the end of its line (PASSWORD=correct horse battery staple)
      .replace(
        /([A-Za-z0-9_.-]*passw(?:or)?d[A-Za-z0-9_-]*\s*[:=]\s*)(?!["'\s])(?!\[redacted\])[^\n]+/gi,
        '$1[redacted]',
      )
      // any other assignment whose name contains a secret word: BOT_TOKEN=, client_secret=, "access_token":, x-api-key:
      .replace(new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*["']?)(?!\\[redacted\\])[^\\s"',}]+`, 'gi'), '$1[redacted]')
      // a setup link: the code lives in the fragment
      .replace(/(\/enroll#)\S+/g, '$1[redacted]')
      // webhook addresses whose path is the secret (signed-URL query values are the query rule above)
      .replace(/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)\S+/gi, '$1[redacted]')
      .replace(/(discord(?:app)?\.com\/api\/webhooks\/)\S+/gi, '$1[redacted]')
      .replace(/(hooks\.zapier\.com\/hooks\/(?:catch|standard)\/)\S+/gi, '$1[redacted]')
      // a numeric id, a colon and a long token
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[redacted]')
      // anything that looks like a key or token: 32+ URL-safe or base64 characters in a row (a path has slashes, so it is safe)
      .replace(/[A-Za-z0-9_+-]{32,}={0,2}/g, '[redacted]')
  )
}
