// Every relay environment variable (spec section 11). A new switch is a flag01 (0|1, default 0: off is today's behaviour)
// with an entry in flags.json at the repo root; scripts/flags.test.ts fails on one without.
import { SEMVER } from '@talos-app/protocol/release-manifest'
import { z } from 'zod'

/** A kill switch: register it in flags.json (scripts/flags.test.ts checks its default and that it is listed). */
const flag01 = z
  .enum(['0', '1'])
  .default('0')
  .transform((v) => v === '1')

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def)

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(8080, 1, 65535),
  /** Holds relay.sqlite and media/. Railway volume mounts at /data. */
  DATA_DIR: z.string().min(1).default('./data'),
  /** https://<host>. Every cookie, CSRF and WebSocket origin check compares against this. */
  PUBLIC_ORIGIN: z
    .string()
    .url()
    .transform((v) => (new URL(v).pathname === '/' ? new URL(v).origin : v)), // drop only a trailing slash; real paths still fail below
  /** Exact host (no scheme, no port). Moving to a custom domain voids every passkey (decision 0001). */
  RP_ID: z.string().min(1),
  RP_NAME: z.string().min(1).default('Talos'),
  /** Raw Ed25519 public key, base64url (43 chars), printed by `talos-app init`. Empty until the Mac has been set up. */
  BRIDGE_PUBKEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  /** 1 = the env key wins over rotated keys in the database (recovery). */
  BRIDGE_PUBKEY_FORCE: flag01,
  /** 32 random bytes, base64 (`openssl rand -base64 32`). AES-256-GCM key for data at rest. */
  DATA_KEY: z.string().refine((v) => /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(v) && atob(v).length === 32, {
    message: 'DATA_KEY must be 32 random bytes, base64',
  }),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  /** Apple rejects subjects that are not mailto: or https:. */
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/)
    .optional(),
  // ---- native push (APNs, IOS-SPEC WP-I5; docs/IOS-PUSH.md). Deliberately lenient: a missing or malformed value never stops
  // the relay booting, it just leaves native push off (`apnsConfigFromEnv` logs which variable). All four are needed.
  /** The 10-character id of the APNs auth key (Apple Developer > Keys). */
  APNS_KEY_ID: z.string().optional(),
  /** The 10-character Apple Team ID. */
  APNS_TEAM_ID: z.string().optional(),
  /** The contents of the AuthKey_XXXX.p8 file (a PEM). Literal `\n` sequences are accepted for one-line pasting. */
  APNS_KEY_P8: z.string().optional(),
  /** The app's bundle id: the APNs topic. */
  APNS_BUNDLE_ID: z.string().optional(),
  BUFFER_DAYS: int(7, 1, 90),
  MEDIA_MAX_MB: int(50, 1, 50),
  /**
   * How often a scheduler alert held by the quiet window is looked at again (seconds). The browser suite runs it faster;
   * never slower than the default, never under 5 s.
   */
  SCHEDULE_ALERT_HOLD_POLL_S: int(60, 5, 60),
  /** Uploads one owner may make in an hour. The default is today's limit. */
  MEDIA_UPLOADS_PER_HOUR: int(60, 1, 100_000),
  /** Megabytes of owner uploads in any 24 hours before the relay answers 429. Share uploads have their own budget and also stop at this limit. */
  MEDIA_DAILY_MAX_MB: int(200, 1, 100_000),
  /** How long a sign-in lasts, in days, counted from when it was last used (the end moves forward each time it is used). */
  SESSION_TTL_DAYS: int(90, 1, 365),
  /** A sign-in unused for this many days ends. Must not be longer than SESSION_TTL_DAYS. */
  SESSION_IDLE_DAYS: int(90, 1, 365),
  VOLUME_SOFT_CAP_MB: int(800, 1),
  /** 0 = no proxy: socket address. Above 0: X-Real-IP (Railway), else the entry this many hops from the right of X-Forwarded-For. */
  TRUST_PROXY_HOPS: int(1, 0, 10),
  /**
   * 1 = a sign-in that names a device must always carry that device's proof. Default 0: a device that has never signed a
   * proof (an older web build) still signs in without one until its first proven sign-in, after which a proof is required.
   */
  DEVICE_PROOF_REQUIRED: z.enum(['0', '1']).default('0'),
  /** off = hard kill for every work integration. */
  WORK_INTEGRATIONS: z.enum(['allow', 'off']).default('allow'),
  /** hosted = run for someone else; self = the owner's own relay (BYOR descriptor, /.well-known/talos-relay). */
  RELAY_KIND: z.enum(['hosted', 'self']).default('self'),
  /** Oldest app version this relay asks for in its descriptor. Advisory: the app shows an update notice, nothing enforces it. */
  MIN_APP_VERSION: z.string().regex(SEMVER, { message: 'must be x.y.z' }).default('0.0.0'),
  /** Key for the short hashes that stand in for client addresses in logs. Default: derived from DATA_KEY. */
  RELAY_LOG_HASH_KEY: z.string().min(16).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // ---- v2 features (docs/V2-FEATURES.md V1.4) ----------------------------------------------------------------------
  /** Optional ntfy topic (`https://`): a phone push that doesn't depend on Web Push. */
  ALERT_NTFY_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('https://'), { message: 'must be an https:// topic URL' })
    .optional(),
  /** Optional bearer for a protected ntfy topic. */
  ALERT_NTFY_TOKEN: z.string().min(1).optional(),
  /** Megabytes all kept bug reports may use together; a new report past it is refused (507). Reports also expire after 90 days. */
  BUG_REPORTS_MAX_MB: int(500, 1, 100_000),
  /** Megabytes every kept org-page version may use together; a publish past it is refused (507 pages_full). */
  PAGES_MAX_MB: int(500, 1, 100_000),
  /** Org pages the relay keeps at most; a new page past it is refused (507 pages_full). Versions of a kept page still go in. */
  PAGES_MAX: int(500, 1, 100_000),
  /**
   * Signs the bug-report webhook (Standard Webhooks): `whsec_` plus base64. The webhook is off unless this is set AND the
   * owner put a URL in config.json (`bug_webhook_url`, set at the Mac). Without it no report is ever sent anywhere.
   */
  BUG_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/]{16,}={0,2}$/, { message: 'must be whsec_ followed by base64' })
    .optional(),
  /**
   * The Talos team's bug inbox (`https://<the team's relay>/api/bug-inbox`), set by whoever deploys this relay for someone
   * else. Used only when the owner set no `bug_webhook_url` of their own, and only with BUG_WEBHOOK_SECRET, which signs the
   * call; the reporter then says reports go to the Talos team. Unset (the default): nothing changes.
   */
  BUG_TEAM_INBOX_URL: z.string().url().optional(),
  /**
   * The bug inbox (`POST /api/bug-inbox`, core/bug-inbox.ts), on the Talos team's relay: one `name=whsec_…` pair per other
   * install, separated by commas, the same secret as that install's BUG_WEBHOOK_SECRET. The name is who a report is from
   * (proven by the signature) and what `talos-app errors list` shows. Unset (the default): the route answers 404 and does nothing.
   */
  BUG_INBOX_SECRETS: z
    .string()
    .transform((v) => v.split(',').map((p) => p.trim()))
    .pipe(
      z
        .array(
          z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,31}=whsec_[A-Za-z0-9+/]{16,}={0,2}$/, {
              message: 'each entry is name=whsec_<base64>, the name in lowercase letters, digits and -',
            })
            .transform((e) => ({ name: e.slice(0, e.indexOf('=')), secret: e.slice(e.indexOf('=') + 1) })),
        )
        .min(1)
        .refine((l) => new Set(l.map((e) => e.name)).size === l.length, { message: 'each name once' })
        .refine((l) => new Set(l.map((e) => e.secret)).size === l.length, { message: 'each secret once' }),
    )
    .optional(),
  /** The bug inbox keeps the marked-up screenshot by default; 1 leaves it out of what reaches the Mac. */
  BUG_INBOX_NO_SCREENSHOT: flag01,
  /** The bug inbox keeps the log lines the sender attached (already cleaned) by default; 1 leaves them out. */
  BUG_INBOX_NO_LOGS: flag01,
  /** The bug inbox keeps the last messages when the sender chose to attach them; 1 leaves them out always. */
  BUG_INBOX_NO_MESSAGES: flag01,
  /** The bug inbox keeps the sender's thread id and screen name by default; 1 leaves them out. */
  BUG_INBOX_NO_THREAD: flag01,
  /** The Talos mod counts as quiet after this many minutes without a sync. */
  MOD_QUIET_MIN: int(10, 1, 24 * 60),
  /** Minimum gap between two bridge-down pushes (a laptop that sleeps is normal). */
  MAC_ALERT_MIN_GAP_MIN: int(120, 0, 24 * 60),
  /** 0 = every /api/share* route answers 404. */
  SHARE_ENABLED: z
    .enum(['0', '1'])
    .default('1')
    .transform((v) => v === '1'),
})

export const RelayEnvSchema = base.superRefine((env, ctx) => {
  if (env.SESSION_IDLE_DAYS > env.SESSION_TTL_DAYS)
    ctx.addIssue({
      code: 'custom',
      path: ['SESSION_IDLE_DAYS'],
      message: 'must not be longer than SESSION_TTL_DAYS (a sign-in cannot idle past its own end)',
    })
  const origin = new URL(env.PUBLIC_ORIGIN)
  if (env.NODE_ENV === 'production') {
    if (origin.protocol !== 'https:')
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be https in production' })
    for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const) {
      if (!env[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required in production (web push)' })
    }
  }
  if (env.RP_ID !== origin.hostname) {
    ctx.addIssue({ code: 'custom', path: ['RP_ID'], message: 'must equal the host of PUBLIC_ORIGIN (no port)' })
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'must be an origin, with no path' })
  }
})

export type RelayEnv = z.infer<typeof RelayEnvSchema>

/** Parses and validates the environment. Throws a readable error listing every bad variable. */
export function loadEnv(source: Record<string, string | undefined> = process.env): RelayEnv {
  const cleaned: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(source)) cleaned[k] = v === '' ? undefined : v
  const res = RelayEnvSchema.safeParse(cleaned)
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`)
    throw new Error(`Invalid relay environment:\n${lines.join('\n')}`)
  }
  return res.data
}
