// Property tests (fast-check) for redact() in src/redact.ts. Fixed seed. Each shape below gets a generator that makes a random secret
// of that shape (random alphabet and length inside the documented bounds) inside random surrounding text.
//
// Shapes, with the source line each comes from (src/redact.ts at the time of writing; comments there are the documentation):
//  S1  long run: 32+ chars of [A-Za-z0-9_+-], e.g. sk_live_ / ghp_ / xoxb- keys ("anything that looks like a key or token")  last .replace
//  S2  Bearer <credential>                                                                          `(Bearer\s+)\S+`
//  S3  TalosBridge <credential>                                                                     `(TalosBridge\s+)\S+`
//  S4  Authorization: <any scheme> <credential>                                                     `(authorization...)` rule
//  S5  Cookie / Set-Cookie header: every pair goes, not only the first; plain, quoted, or the JSON form {"cookie": "a=1; b=2"}   cookie rule
//  S6  query-string parameter with a secret name (also client_key, oauth_code: key and code after a credential word);
//      name and the other parameters stay                                                           QUERY_SECRET_NAME rule
//  S7  --password / --pass / --token flag value (space or =; quoted; may start with one dash)       `(--(?:password|pass|token)...)` rule
//  S8  curl / wget / http -u user:password and --user; user stays, password goes (quoted too); an API key as the user (`-u sk_x:`)
//                                                                                                   redactUserFlags
//  S9  AWS access key id plus the 40-character secret on the same line, either order, id glued to letters   awsPairs
//  S10 scheme://user:password@host; user and host stay; the user may be empty (redis://:pw@host); the password may hold @ ? #
//                                                                                                   URL-password rule
//  S11d names of 65..200 characters before the keyword; an unclosed quoted value (every word after the quote goes)
//  S11 NAME=value / "name": "value" with a secret word in the name (token, secret, api key ...; names may carry . - and digits);
//      unquoted, quoted (the other quote may sit inside), and JSON; an unquoted PASSWORD runs to the end of its line
//                                                                                                   SECRET_NAME rules
//  S12 setup link /enroll#<code>                                                                    `(\/enroll#)\S+`
//  S13 webhook addresses whose path is the secret (Slack, Discord, Zapier)                          hooks.slack.com / discord / zapier rules
//  S14 <numeric id>:<30+ char token>, the id possibly glued to letters, the token possibly ending in -   `\d{6,}:[A-Za-z0-9_-]{30,}`
//  S15 BRIDGE_PUBKEY=<20+ chars> (also with a colon)                                                `(BRIDGE_PUBKEY\s*[=:]\s*)...`
//  S16 the user's home folder shown as ~ (the user's name is in it)                                  RedactOptions.userHome
//
// Surroundings. The prefix and suffix are drawn from [a-z ] and are at most 20 characters, so they have no digit, no `=` `:` `?` `#`
// `/`, quote or dash (every shape needs one of them) and no run of 32 characters (S1, S14). They are joined to the shape with a
// newline, a space, nothing at all, or one of `(` `"` `,`, so a prefix can sit glued to the shape and a suffix to the secret. A case
// where a surrounding text CONTAINS the secret is discarded (fc.pre): then the secret would be there whatever redact does.
// A short random secret could also appear in redact's own fixed output ("cook" inside "Cookie"). `check` skips such a case
// (fc.pre) only when the secret still shows up after the secret itself is swapped for a placeholder, i.e. it is not the secret
// that leaked.
// The two curl shapes (S8, S8b) start with a space: a command word glued to letters (acurl) is another word, not curl.
// Two shapes in one text: the last property puts two generated shapes on one line (joined with a space, `; ` or `, `) or on two.
import fc from 'fast-check'
import { describe, it } from 'vitest'
import { redact } from '../src/redact.ts'

const SEED = 20261119
const RUNS = 1500
const opts = { seed: SEED, numRuns: RUNS }

const chars = (alphabet: string, min: number, max: number) =>
  fc.string({ unit: fc.constantFrom(...alphabet.split('')), minLength: min, maxLength: max })
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const LETT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const around = chars(`${LOWER} `, 0, 20)
const joiner = fc.constantFrom('\n', ' ', '', '(', '"', ',')

type Case = { text: string; secrets: string[]; keeps: string[] }

/** Throws if a secret survived or a kept part was lost; skips (fc.pre) cases where the secret is only a coincidence. */
function verify(text: string, secrets: string[], keeps: string[], surroundings: string[]) {
  for (const s of secrets) fc.pre(!surroundings.some((x) => x.includes(s)))
  const out = redact(text)
  for (const s of secrets) {
    let swapped = text
    for (const x of secrets) swapped = swapped.split(x).join('ZZ')
    fc.pre(!redact(swapped).includes(s))
    if (out.includes(s))
      throw new Error(`secret ${JSON.stringify(s)} survived: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`)
  }
  for (const k of keeps) {
    if (!out.includes(k))
      throw new Error(`kept part ${JSON.stringify(k)} lost: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`)
  }
}

const tokChars = `${ALNUM}._~+/=-`
const secretWords = [
  'token',
  'secret',
  'password',
  'passwd',
  'cookie',
  'api_key',
  'api-key',
  'apikey',
  'private_key',
  'credential',
]
const nameChars = `${LETT}_.-0123456789`
const nameArb = fc
  .tuple(chars(nameChars, 0, 6), fc.constantFrom(...secretWords), chars(nameChars, 0, 6))
  .map(([a, w, b]) => `${a}${w}${b}`)
const quote = fc.constantFrom('"', "'")
const words = fc.array(chars(ALNUM, 4, 10), { minLength: 1, maxLength: 4 })
const credWords = [
  'client',
  'oauth',
  'auth',
  'api',
  'access',
  'license',
  'invite',
  'verification',
  'otp',
  'refresh',
  'login',
]

const shapes: Record<string, fc.Arbitrary<Case>> = {
  'S1 long run (sk_live_ / ghp_ / xox / bare), 32..80 chars': fc
    .tuple(fc.constantFrom('sk_live_', 'sk-', 'ghp_', 'xoxb-', 'pk_test_', ''), chars(`${ALNUM}_+-`, 20, 70))
    .map(([pre, body]) => {
      const secret = pre + body.padEnd(Math.max(0, 32 - pre.length), 'a')
      return { text: `key ${secret} end`, secrets: [secret], keeps: [] }
    }),
  'S2 Bearer': chars(tokChars, 6, 60).map((tok) => ({
    text: `curl -H 'Authorization: Bearer ${tok}'`,
    secrets: [tok],
    keeps: [],
  })),
  'S2b Bearer, bare line': chars(tokChars, 6, 60).map((tok) => ({ text: `Bearer ${tok}`, secrets: [tok], keeps: [] })),
  'S3 TalosBridge': chars(tokChars, 6, 60).map((tok) => ({ text: `TalosBridge ${tok}`, secrets: [tok], keeps: [] })),
  'S4 Authorization with any scheme': fc
    .tuple(fc.constantFrom('Basic', 'Token', 'Digest', 'Zapier-Key', 'Made-Up'), chars(tokChars, 6, 50))
    .map(([scheme, cred]) => ({ text: `Authorization: ${scheme} ${cred}`, secrets: [cred], keeps: ['Authorization'] })),
  'S5 Cookie header: plain, quoted values and the JSON form': fc
    .tuple(
      fc.constantFrom('Cookie', 'Set-Cookie', 'cookie'),
      fc.array(chars(ALNUM, 6, 24), { minLength: 1, maxLength: 4 }),
      fc.constantFrom('plain', 'dq', 'sq', 'json', 'jsonsq'),
    )
    .map(([h, vals, form]) => {
      const pair = (v: string, i: number) =>
        form === 'dq' ? `c${i}="${v}"` : form === 'sq' ? `c${i}='${v}'` : `c${i}=${v}`
      const pairs = vals.map(pair).join('; ')
      const text =
        form === 'json' ? `{"${h}": "${pairs}"}` : form === 'jsonsq' ? `{'${h}': '${pairs}'}` : `${h}: ${pairs}`
      return { text, secrets: vals, keeps: [] }
    }),
  'S6 query-string secret name, name and other parameters stay': fc
    .tuple(
      fc.oneof(
        fc
          .tuple(
            chars(`${LETT}_.`, 0, 5),
            fc.constantFrom(
              'token',
              'secret',
              'password',
              'passwd',
              'api_key',
              'apikey',
              'access_key',
              'private_key',
              'credential',
              'signature',
            ),
            chars(`${LETT}_.`, 0, 5),
          )
          .map((a) => a.join('')),
        fc.constantFrom(
          'key',
          'code',
          'sig',
          'pwd',
          'auth',
          'session',
          'session_id',
          'X-Amz-Signature',
          'x-api-key',
          'refresh_token',
        ),
        // key and code after a credential word, between - _ . separators
        fc
          .tuple(fc.constantFrom(...credWords), fc.constantFrom('_', '-', '.'), fc.constantFrom('key', 'code'))
          .map((a) => a.join('')),
      ),
      chars(`${ALNUM}%._~-`, 6, 50),
      fc.constantFrom('?', '&'),
    )
    .map(([name, val, sep]) => ({
      text: `GET https://h.example.org/p${sep === '?' ? '?' : '?a=1&'}${name}=${val}&z=2#frag`,
      secrets: [val],
      keeps: [`${name}=`, 'z=2', 'https://h.example.org/p'],
    })),
  'S7 --password / --pass / --token': fc
    .tuple(
      fc.constantFrom('--password', '--pass', '--token'),
      fc.constantFrom(' ', '='),
      fc.oneof(
        chars(`${ALNUM}_.`, 6, 30),
        chars(`${ALNUM}_.`, 6, 30).map((v) => `-${v}`),
        fc.tuple(quote, words).map(([q, w]) => `${q}${w.join(' ')}${q}`),
      ),
      fc.constantFrom('tool login', 'deploy'),
    )
    .map(([flag, sep, val, cmd]) => ({
      text: `${cmd} ${flag}${sep}${val} --verbose`,
      secrets: [val.replace(/^["']|["']$/g, '').replace(/^-/, '')],
      keeps: [flag, '--verbose'],
    })),
  'S8 curl/wget/http -u user:password and --user, quoted or not; the user stays': fc
    .tuple(
      fc.constantFrom('curl', 'wget', 'http', 'https', '/usr/bin/curl', './curl'),
      fc.constantFrom('-u ', '-u', '--user ', '--user='),
      chars(LOWER, 3, 10),
      chars(`${ALNUM}!#$%^*()_+=.:,-`, 6, 30),
      fc.constantFrom('', '"', "'"),
    )
    .map(([tool, flag, user, pass, q]) => ({
      text: ` ${tool} ${flag}${q}${user}:${pass}${q} https://example.org/x`,
      secrets: [pass],
      keeps: [`${user}:`, 'https://example.org/x'],
    })),
  'S8b an API key as the user, no password (-u sk_x:)': fc
    .tuple(
      fc.constantFrom('curl', 'wget', 'http'),
      fc.constantFrom('sk_test_', 'sk_live_', 'key-', ''),
      chars(ALNUM, 8, 30),
    )
    .map(([tool, pre, key]) => ({
      text: ` ${tool} -u ${pre}${key}: https://example.org/x`,
      secrets: [`${pre}${key}`],
      keeps: ['https://example.org/x'],
    })),
  'S9 AWS key id and the 40-char secret on one line, either order, glued to letters, with = or : around it': fc
    .tuple(
      fc.constantFrom('AKIA', 'ASIA'),
      chars('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16, 16),
      chars(`${ALNUM}+/`, 40, 40),
      fc.constantFrom(',', ' ', ';'),
      fc.constantFrom('', 'key', ' ', 'id='),
      fc.constantFrom(
        'idFirst',
        'secretFirst',
        'idEq',
        'idEqSpace',
        'secretColonId',
        'secretColonSpaceId',
        'idColonSecretRegion',
      ),
    )
    .map(([pre, id, sec, sep, glue, form]) => {
      const key = `${pre}${id}`
      const text = {
        idFirst: `export,${glue}${key}${sep}${sec}`,
        secretFirst: `export,${sec}${sep}${glue}${key}`,
        idEq: `export,${key} ${sec}=`,
        idEqSpace: `export,${key} ${sec} =`,
        secretColonId: `export,${sec}:${key}`,
        secretColonSpaceId: `export,${sec}: ${key}`,
        idColonSecretRegion: `export,${key}:${sec}:us-east-1`,
      }[form] as string
      return { text, secrets: [key, sec], keeps: [] }
    }),
  'S10 URL with credentials, user and host stay; empty user; @ inside the password': fc
    .tuple(
      fc.constantFrom('https', 'postgres', 'ftp', 'amqps', 'git+ssh', 'redis'),
      fc.oneof(chars(LOWER, 3, 10), fc.constant('')),
      fc.oneof(
        chars(`${ALNUM}!$:.,%@?#`, 6, 30),
        // digits first and then ? or # (2024#Q7w..., 1234?Q7w...): a password, not a port with a query
        fc.tuple(chars('0123456789', 1, 6), fc.constantFrom('?', '#'), chars(ALNUM, 6, 20)).map((a) => a.join('')),
      ),
    )
    .map(([scheme, user, pass]) => ({
      text: `${scheme}://${user}:${pass}@db.example.org:5432/app`,
      secrets: [pass],
      keeps: [`${scheme}://${user}:`, '@db.example.org:5432/app'],
    })),
  'S11a NAME=value / "name": value, unquoted; names with . - and digits': fc
    .tuple(nameArb, fc.constantFrom('=', ': ', ' = ', '":'), chars(`${ALNUM}_./+-`, 6, 40))
    .map(([name, sep, val]) => ({ text: `${name}${sep}${val}`, secrets: [val], keeps: [] })),
  'S11b NAME="value with spaces" (quoted), the other quote may sit inside': fc
    .tuple(nameArb, quote, words, fc.boolean())
    .map(([name, q, w, inner]) => {
      const other = q === '"' ? "'" : '"'
      const value = inner && w.length > 1 ? `${w[0]}${other}s ${w.slice(1).join(' ')}` : w.join(' ')
      return { text: `${name}=${q}${value}${q}`, secrets: [...w, value], keeps: [] }
    }),
  'S11b2 JSON form "name": "value"': fc
    .tuple(nameArb, quote, words, fc.constantFrom(', "ok": true}', '}', ''))
    .map(([name, q, w, tail]) => ({
      text: `{${q}${name}${q}: ${q}${w.join(' ')}${q}${tail}`,
      secrets: [...w, w.join(' ')],
      keeps: [],
    })),
  'S11d a long name before the keyword (65..200 characters), and an unclosed quote': fc
    .tuple(
      chars(nameChars, 65, 200),
      fc.constantFrom(...secretWords),
      chars(nameChars, 0, 6),
      words,
      fc.constantFrom('', '"', "'"),
    )
    .filter(([pre, , post, vals]) => vals.every((v) => !pre.includes(v) && !post.includes(v)))
    .map(([pre, w, post, vals, q]) => ({
      // with a quote given it is left unclosed: every word after it is secret too; with none, the value is its first word
      text: `${pre}${w}${post}=${q}${(q ? vals : vals.slice(0, 1)).join(' ')}`,
      secrets: q ? vals : vals.slice(0, 1),
      keeps: [],
    })),
  'S11c PASSWORD=unquoted words to the end of the line': fc
    .tuple(fc.constantFrom('PASSWORD', 'db_password', 'passwd', 'Password', 'db.password.prod'), words)
    .map(([name, w]) => ({ text: `${name}=${w.join(' ')}`, secrets: [w.join(' ')], keeps: [] })),
  'S12 /enroll# setup link': chars(`${ALNUM}_-`, 6, 60).map((code) => ({
    text: `open https://app.example.org/enroll#${code}`,
    secrets: [code],
    keeps: ['/enroll#'],
  })),
  'S13 webhook addresses': fc
    .tuple(
      fc.constantFrom(
        'https://hooks.slack.com/services/',
        'https://hooks.slack.com/workflows/',
        'https://hooks.slack.com/triggers/',
        'https://discord.com/api/webhooks/',
        'https://discordapp.com/api/webhooks/',
        'https://hooks.zapier.com/hooks/catch/',
        'https://hooks.zapier.com/hooks/standard/',
      ),
      fc.array(chars(`${ALNUM}_-`, 4, 16), { minLength: 1, maxLength: 3 }),
    )
    .map(([base, segs]) => ({ text: `${base}${segs.join('/')}`, secrets: [segs.join('/')], keeps: [base] })),
  'S14 numeric id : 30+ char token, id glued to letters, token ending in -': fc
    .tuple(
      chars('0123456789', 6, 12),
      chars(`${ALNUM}_-`, 29, 59),
      fc.constantFrom('-', 'a', '_'),
      fc.constantFrom('bot ', 'bot', 'x', ''),
    )
    .map(([id, body, last, glue]) => {
      const tok = body + last
      return { text: `${glue}${id}:${tok}`, secrets: [tok, `${id}:${tok}`], keeps: [] }
    }),
  'S15 BRIDGE_PUBKEY= (or :)': fc
    .tuple(chars(`${ALNUM}_+/-`, 20, 60), fc.constantFrom('=', ': ', ' = ', ':'))
    .map(([key, sep]) => ({ text: `BRIDGE_PUBKEY${sep}${key}`, secrets: [key], keeps: ['BRIDGE_PUBKEY'] })),
}

describe('redact: every claimed shape is scrubbed', () => {
  for (const [name, arb] of Object.entries(shapes)) {
    it(name, () => {
      fc.assert(
        fc.property(around, joiner, joiner, arb, around, (p, j1, j2, c, s) => {
          verify(`${p}${j1}${c.text}${j2}${s}`, c.secrets, c.keeps, [p, s])
        }),
        opts,
      )
    })
  }

  it('two different shapes in one text: both secrets go', () => {
    // S11d is left out: its unclosed quote runs on into whatever is on the same line (an apostrophe in the next shape closes it)
    const names = Object.keys(shapes).filter((n) => !n.startsWith('S11d'))
    const two = fc
      .tuple(fc.constantFrom(...names), fc.constantFrom(...names))
      .chain(([a, b]) => fc.tuple(shapes[a] as fc.Arbitrary<Case>, shapes[b] as fc.Arbitrary<Case>))
    fc.assert(
      fc.property(two, joiner, fc.constantFrom('\n', ' ', '; ', ', '), ([x, y], j, mid) => {
        fc.pre(x.secrets.every((s) => !y.text.includes(s)) && y.secrets.every((s) => !x.text.includes(s)))
        verify(`${j}${x.text}${mid}${y.text}${j}`, [...x.secrets, ...y.secrets], [], [])
      }),
      opts,
    )
  })

  it('S16 (checked directly)', () => {
    fc.assert(
      fc.property(chars(LOWER, 6, 12), chars(LOWER, 6, 10), (user, app) => {
        const home = `/home/${user}`
        const out = redact(`cat ${home}/.cfg and ${home}/${app}/log`, { userHome: home, appHome: `${home}/${app}` })
        fc.pre(!redact('cat ~/.cfg and $TALOS_APP_HOME/log').includes(user))
        if (out.includes(user)) throw new Error(`user name survived: ${out}`)
        if (!out.includes('$TALOS_APP_HOME/log') || !out.includes('~/.cfg'))
          throw new Error(`folders not shown as ~: ${out}`)
      }),
      opts,
    )
  })
})
