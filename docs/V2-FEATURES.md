# Talos app: v2 features addendum (rev 2)

> Extends the original build spec (not published) (v1 rev 2 + WP8 addendum), [SCHEDULES.md](SCHEDULES.md) and [CLAUDE-CODE.md](CLAUDE-CODE.md),
> and follows SPEC section 0 (builder rules) unchanged. Section numbers are this addendum's own (`V0`...). The SPEC
> tables it changes are already updated in SPEC.md. Copied from the design spec by `scripts/v2-features-doc.ts`.
> **INFERENCE** marks a claim not checked against a source or a run; **SMOKE** marks one that needs a real device (V9).
>
> **Calls made while building WP-V0** (they win over the text below where they differ; the text is already edited):
> - **Zero-tap share filing.** The bridge, not the agent, appends every Shortcut share to
>   `$TALOS_APP_HOME/shared-inbox/<day>.md`, still inside its wrapExternal markers, idempotent on `share_id`, and tells
>   the agent it is saved. No agent judgment is involved, so a share has nothing to inject into, and saving costs no tap.
> - **The driving voice follow-up is sent `silent`**, so a reply in driving mode pushes once, not twice.
> - **Relay features ride on the existing `ready.features`**, which already means "what the relay supports"; there is
>   no separate relay-features field. Modules add theirs with `registerRelayFeature()` when they land.
> - **The hourly external check is dropped for now (owner decision; v1.1).** Everything about the GitHub Actions
>   workflow in V0, V2.1, V2.3 rule 4, V2.4, V2.6, V7, V8 and V9.2 is deferred: no `GET /api/health`, no
>   `HEALTH_TOKEN` or `HEALTH_CHECK_STALE_H`, no `health_check_stale` push, no `external_check` field and no
>   `examples/health.yml`. What stays: the relay watchdog (bridge and mod quiet, quiet window respected), optional ntfy,
>   and `GET /api/status` behind Settings -> Health.
> - **Owner defaults (V10):** search keeps 90 days by default and `TALOS_APP_HISTORY_DAYS=0` keeps text forever (the
>   setting ships in V0); shared items are read, summarised and drafted with no tap, and only side effects get a card.

## V0. Answer in one screen

- **Health alarms.** Each layer covers the gap in the one before it.
  1. **Relay watchdog.** It web-pushes, once per outage, when the bridge (the existing 5-min alarm) or the Talos mod
     (new, 10 min) goes quiet. These Mac-side alarms respect the quiet window and are rate-limited, because a laptop
     that sleeps is normal.
  2. **Hourly GitHub Actions workflow.** It calls a token-gated `GET /api/health` and fails (GitHub emails) **only when
     the relay itself is down or reports a relay-side problem**. That's the one thing the relay can't report about
     itself.
  3. **Optional ntfy topic.** Used by both, it gives a phone push that doesn't depend on Web Push.

  The relay also pushes when the hourly check stops arriving. Settings → Health shows the last-seen times.
- **Search** runs on the Mac: SQLite FTS5 in `history.sqlite`, through the signed frames `search.query` and
  `search.results`.
  - The index is updated **after** each message write commits, in its own transaction, so search can never fail a
    message.
  - Results rank recent-and-relevant first and say whether the match was in the text, a transcript, or an attachment
    name.
  - The relay only forwards. With the Mac offline, search falls back to messages cached on the device.
  - SQLite here is **macOS's system library**: 3.51.0 on macOS 26.7.1, which `bun:sqlite` loads, with FTS5 checked in a
    run on 2026-10-29. The bridge probes for it at start.
- **Driving mode.** One toggle sets `voice_notes.driving_until` through the existing signed `config.patch`.
  - Every agent reply goes out as text at once, and a spoken version follows.
  - The `/drive` screen auto-plays with large controls.
  - Autoplay works only while Talos is in the foreground.
- **Share from any app: iOS does not support Web Share Target, as of October 2026.**
  - MDN's compat data has `safari: false` and `safari_ios: mirror`, with the bug linked.
  - WebKit bug 194593 ("Add support for Web Share Target API") is still NEW and unassigned; its last change was
    2026-05-23.
  - firt.dev's iOS PWA notes, updated 2026-10-13 and covering up to iOS 27.0, mark `share_target` ❌.

  How each platform shares:
  - **iOS:** an **iOS Shortcut** posting to `POST /api/share` with a device-bound bearer token. The token can do one
    thing: drop text and links (files only if allowed) into **Inbox** as **untrusted data**. It can't fetch, write
    memory, or use tools.
  - **Android Chrome (76+) and Chromium desktop:** a manifest `share_target`.
  - **Everywhere:** a `/share` page that also works as a bookmarklet.

  Shared material is always wrapped as external, even on the signed page.
- **Memory browser.** A read-only tree, markdown view and FTS5 search over the folders listed in a Mac-only
  `memory.json`.
  - It's off until `talos-app memory init`.
  - There's a hard denylist, plus a `.talos-private` marker file.
  - Frames are byte-fit and paged.
  - There's no write-back.

---

## V1. The protocol PR (WP-V0; adds to SPEC 3.1-3.8)

**One PR for all four features**, written by the architect before fan-out, on the WP-S0 / WP-C0.5 pattern.

- **New files:** `packages/protocol/src/health.ts`, `search.ts`, `memory.ts`, `share.ts`, `driving.ts` and
  `fts-query.ts`.
- **Shared files:** each existing file gets one-line spreads or a few rows: `frames.ts`, `models.ts`, `config.ts`,
  `errors.ts`, `http.ts`, `push.ts`, `channel-meta.ts`, `ids.ts` and `index.ts`. That keeps the conflict with MCP Apps'
  AP0 to list lines.

**Feature flags.**
- **Bridge features** go in `hello.client.features`: `search/1`, `memory/1`, `driving/1`, `health/1` (the bridge sends
  beats).
- **Relay features** go in the existing `ready.features` that the relay fills from its own code: `health/1`, `share/1`.
  So Settings → Health and share tokens stay reachable while the Mac is down.
- **Last-known.** While the bridge is offline, `presence.features` keeps the **last-known** bridge list, with
  `presence.features_at`. The app shows Search and Memory as "Needs your Mac" instead of hiding them, and Memory's
  offline cache stays reachable. That echo is WP-S2's (SCHEDULES S4.5). V0 lists it under `## Requests` and builds it
  itself if S2 hasn't merged.
- **Cap.** `features` is `.max(20)` (`frames.ts:82,107`). Today's lists (schedules, Claude Code, MCP Apps and these)
  fit; the next addendum must count.

### V1.1 Ids and primitives (adds to 3.2; `ids.ts`)

```ts
export const ShareTokenId = z.string().regex(/^sh_[0-9A-HJKMNP-TV-Z]{26}$/)
export const MemoryRootId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
/** Relative POSIX path inside a root: no leading '/', no '.' or '..' segment, no NUL/C0, no '\\', ≤ 512 UTF-8 bytes. */
export const MemoryPath = z.string().max(512).refine(isSafeRelPath)
export const PageCursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) // opaque to the app (search, memory listing)
```

### V1.2 Models

```ts
// health.ts
export const RelayProblem = z.enum(['storage_full', 'no_alert_path']) // no_alert_path = 0 push subscriptions AND ntfy off
export const MacProblem = z.enum(['bridge_offline', 'mod_quiet']) // after 5 min / MOD_QUIET_MIN
export const ModHealth = z.object({
  state: z.enum(['alive', 'quiet', 'absent']), // alive = a sync within MOD_LIVE_WINDOW_MS (30 s, session.ts:22)
  last_seen: IsoTs.nullable(),
  expected: z.boolean(), // the mod synced at least once in the last 7 days (bridge kv `mod_seen_at`)
})
export const HealthBeat = z.object({
  // bridge → relay, every 60 s and on any change
  bridge: z.object({ version: z.string().max(40), started_at: IsoTs }),
  mod: ModHealth,
  tts: z.boolean(),
  stt: z.boolean(),
  sqlite: z.object({ fts5: z.boolean() }), // probe result (V3.1); false = search/memory not advertised
  search: z.object({ state: z.enum(['off', 'indexing', 'ready', 'dirty']), docs: z.number().int() }).optional(),
  memory: z
    .object({ state: z.enum(['off', 'indexing', 'ready']), files: z.number().int(), truncated: z.boolean() })
    .optional(),
})
export const HealthStatus = z.object({
  // GET /api/health and GET /api/status
  at: IsoTs,
  relay_ok: z.boolean(), // = relay_problems is empty. The ONLY thing the workflow fails on
  relay_problems: z.array(RelayProblem),
  relay: z.object({ version: z.string(), up_since: IsoTs }),
  mac_problems: z.array(MacProblem), // informational for the workflow; the watchdog alerts on these
  bridge: z.object({ online: z.boolean(), last_seen: IsoTs.nullable(), down_since: IsoTs.nullable() }),
  mod: ModHealth.extend({ state: z.enum(['alive', 'quiet', 'absent', 'unknown']) }), // unknown = bridge offline
  push: z.object({ subscriptions: z.number().int(), last_ok_at: IsoTs.nullable(), last_error_at: IsoTs.nullable() }),
  ntfy: z.boolean(), // ALERT_NTFY_URL is set (never the URL)
  external_check: z.object({ last_at: IsoTs.nullable(), stale: z.boolean() }),
  beat: HealthBeat.omit({ bridge: true }).partial().optional(), // /api/status only
})
```

```ts
// search.ts
export const SearchFilters = z
  .object({
    thread_ids: z.array(ThreadId).max(40), // [] = all threads
    from: z.enum(['any', 'owner', 'agent']), // 'agent' includes system rows; hook and share rows only under 'any'
    has_file: z.boolean().nullable(), // role 'attachment' and kind ≠ voice_note; voice replies never count
    after: IsoTs.nullable(),
    before: IsoTs.nullable(),
  })
  .strict()
export const SearchHit = z.object({
  message_id: MsgId,
  thread_id: ThreadId,
  seq: z.number().int().nullable(),
  author: Message.shape.author,
  kind: Message.shape.kind,
  via: Message.shape.via,
  created_at: IsoTs,
  match_in: z.enum(['text', 'transcript', 'attachment_name', 'attachment_text', 'card']), // one per FTS column (V3.1)
  snippet: z.string().max(320), // plain text, never HTML
  marks: z.array(z.tuple([z.number().int(), z.number().int()])).max(20), // [start, end) UTF-16 offsets into snippet
  attachment: AttachmentRef.pick({ media_id: true, name: true, mime: true, kind: true }).optional(),
})
```

```ts
// memory.ts
export const MemoryEntry = z.object({
  name: z.string().max(255),
  path: MemoryPath,
  type: z.enum(['dir', 'file']),
  size: z.number().int().optional(),
  mtime: IsoTs.optional(),
  title: z.string().max(200).optional(),
  previewable: z.boolean().optional(),
})
export const MemoryRootInfo = z.object({ id: MemoryRootId, label: z.string().max(40), files: z.number().int() })
export const MemoryHit = z.object({
  root_id: MemoryRootId,
  path: MemoryPath,
  title: z.string().max(200),
  snippet: z.string().max(320),
  marks: SearchHit.shape.marks,
  mtime: IsoTs,
})
export const MemoryLink = z.object({
  text: z.string().max(200),
  root_id: MemoryRootId.nullable(),
  path: MemoryPath.nullable(),
})
export const MessageRef = z
  .object({
    kind: z.literal('memory'),
    root_id: MemoryRootId,
    path: MemoryPath,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
```

```ts
// share.ts
export const ShareScope = z.enum(['text', 'files']) // 'text' covers text + url + title + note; 'files' is opt-in
export const ShareToken = z.object({
  id: ShareTokenId,
  label: z.string().min(1).max(40),
  device_id: DeviceId, // bound: a revoked device's tokens fail at lookup (join on devices.revoked)
  scopes: z.array(ShareScope).min(1).max(2), // always contains 'text'
  created_at: IsoTs,
  last_used_at: IsoTs.nullable(),
  last_used_net: z.string().max(50).nullable(), // coarse source: IPv4 /24 or IPv6 /48, e.g. "203.0.113.0/24"
  revoked_at: IsoTs.nullable(),
})
// Target is always the system thread 'inbox'. No thread choice, no reads, no other route.
export const SharePostBody = z
  .object({
    // JSON, or multipart with the same names plus ≤ 4 `file` parts
    text: z.string().max(32_000).optional(),
    url: HttpsUrl.optional(),
    title: z.string().max(300).optional(),
    note: z.string().max(4000).optional(),
  })
  .strict()
// Non-empty rule (checked by the relay after parsing, so multipart file parts count): text || url || note || files ≥ 1.
export const ShareContent = z
  .object({
    // the shared material; always wrapped external by the bridge
    text: z.string().max(32_000).optional(),
    url: HttpsUrl.optional(),
    title: z.string().max(300).optional(),
  })
  .strict()
```

```ts
// driving.ts (pure; the bridge's reply path and the app both call it)
export function drivingActive(cfg: AgentConfigT, now: number): boolean // driving_until > now
export function wantVoiceReply(cfg: AgentConfigT, now: number, askedVoice: boolean): boolean
// driving active → true (overrides 'never'); else 'always' → true, 'never' → false, 'when_voice' → askedVoice
export function spokenText(text: string, voiceText?: string): string | null
// voice_text ?? markdownToPlain(text) with every wrapExternal block removed, ≤ 1500 chars;
// null when > 40 % of the text is inside code fences (the Codex rule, V6): the bridge then speaks
// "Details are in the thread." instead
```

`markdownToPlain` moves from `apps/bridge/src/markdown-plain.ts` into the protocol (pure). The bridge re-exports it.

**Changes to existing models and config:**
- `Message.via` adds `'share'`.
- `Message.refs?: MessageRef[]` (≤ 5).
- `Message.share_content?: ShareContent`, set on shares from either path.
- `AgentConfig.voice_notes.driving_until`: `IsoTs.nullable().default(null)`, patchable under `voice_notes.*`.
- `AgentConfig.memory_browser`: `z.boolean().default(true)`, a kill switch. Over `config.patch` the bridge accepts
  `false` only; `true` comes from the Mac (V5.1).
- The two bridge rules (the `memory_browser` direction, the 12 h clamp on `driving_until`) live in
  `apps/bridge/src/config-file.ts`, owned by WP-V0.

### V1.3 Frames (adds to 3.4)

These follow the Schedules rules (SCHEDULES S2.2):
- **Search and memory frames** aren't durable or consumable, are never stored by the relay, and go only to the asking
  socket.
- **One router.** The relay has one request router, `core/ephemeral.ts`: `request_id → socket`, 30 s TTL, 100 per
  socket, and `mac_offline` at once. If WP-S2 has merged, V0 lifts S2's `scheduleReqs` map into it in the same PR;
  otherwise S2 registers `schedules.snapshot` and `schedule.detail` in it.
- **Timeout.** No answer in 15 s → "Your Mac didn't answer."
- **Bridge queue.** The bridge verifies and serves signed reads on a `readQueue`, like `schedQueue` (`inbound.ts:67`),
  so a search never waits behind chat.
- **Signing.** 🔏 frames are `.strict()` with no `.default()`. Reads are signed: it costs nothing and stops a relay from
  reading files through the bridge.
- **Seen ids.** Signed reads land in `seen_ids` for 8 days. That's fine at these rates: 120/min of typing is about 1.4M
  ids a week at the very worst, and about 1k in practice.

| type                         | direction        | durable                  | fields (beyond envelope)                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.beat`                | bridge→relay     | no; relay keeps the last | `beat` (HealthBeat)                                                                                                                                                                                                                                                                |
| `search.query` 🔏            | app→relay→bridge | no                       | `request_id`, `q` (1-200 chars, ≤ 12 terms), `filters`, `sort` (`relevance`\|`newest`), `cursor` (PageCursor or null), `limit` (1-50), `device_id`, `osig`                                                                                                                         |
| `search.results`             | bridge→relay→app | no                       | `request_id`, `hits` (≤ 50), `next_cursor`, `total_estimate` (capped 1000), `took_ms`, `index` (`ready`\|`indexing`\|`dirty`). Fit by encoded bytes like `history.page`                                                                                                            |
| `history.request` (addition) | app→relay→bridge | no                       | at most one of `before_id?`, `after_id?`, `around_id?` (MsgId), besides the existing `before_seq`/`before_ts`. Any of the three → the relay forwards to the bridge (an `around_id` inside its buffer may be served from the buffer when the Mac is offline)                        |
| `history.page` (addition)    | bridge→relay→app | no                       | `has_newer?` (bool), `anchor_id?` (echoed)                                                                                                                                                                                                                                         |
| `memory.tree` 🔏             | app→relay→bridge | no                       | `request_id`, `root_id` (or null = roots), `path` (`''` = top), `cursor` (or null), `device_id`, `osig`                                                                                                                                                                            |
| `memory.listing`             | bridge→relay→app | no                       | `request_id`, `roots?` (≤ 20), `root_id?`, `path?`, `entries` (dirs first, then name), `next_cursor` (or null). Fit by encoded bytes: entries are added until the frame would exceed `MAX_FRAME_BYTES − 2 KiB`, then the cursor continues                                          |
| `memory.read` 🔏             | app→relay→bridge | no                       | `request_id`, `root_id`, `path`, `offset` (UTF-8 byte offset, 0 = start), `device_id`, `osig`                                                                                                                                                                                      |
| `memory.file`                | bridge→relay→app | no                       | `request_id`, `root_id`, `path`, `mime`, `text`, `offset`, `next_offset` (or null = end), `size`, `mtime`, `sha256` (whole file), `links` (first chunk only, ≤ 128 KiB encoded, dropped first if room runs short). Fit by encoded bytes; `text` cut on a UTF-8 code-point boundary |
| `memory.search` 🔏           | app→relay→bridge | no                       | `request_id`, `q`, `root_ids` (≤ 20; [] = all), `cursor`, `limit` (1-50), `device_id`, `osig`                                                                                                                                                                                      |
| `memory.results`             | bridge→relay→app | no                       | `request_id`, `hits` (≤ 50), `next_cursor`, `index`. Byte-fit                                                                                                                                                                                                                      |
| `message` (addition) 🔏      | app→relay→bridge | yes                      | `refs?` (≤ 5 MessageRef; only when `memory/1` advertised), `share_content?` (ShareContent; only from `/share`)                                                                                                                                                                     |
| `share.item`                 | relay→bridge     | yes, **consumable**      | `share_id`, `token_id`, `token_label`, `message` (Message: author `owner`, via `share`, thread `inbox`, `text` = the note or empty, `share_content`, attachments; built by the relay)                                                                                              |
- **`share.item`** joins `CONSUMABLE_FRAME_TYPES`. The relay stores its `message` and emits it like `message.stored`.
  On notify, the bridge writes the Message to `history.sqlite` (`addMessage`), so shares are on the Mac and searchable
  after the buffer ages out.
- **New ErrorCodes:**
  - `search_unavailable` (no FTS5, or the index is empty and building);
  - `bad_query`;
  - `memory_off`;
  - `memory_not_found` (also for excluded, private and denylisted paths, with no distinction);
  - `share_token_invalid`;
  - `share_disabled`.
- **Channel kinds:** add `share`. **No new trust value:** shares use `external` (token path) or `owner` with wrapped
  content (signed page), V4.7. **Meta keys:** `driving`, `memory_path`, `memory_root`, `memory_changed`, `share_id`,
  `share_source`. (`share_url` stays in the schema, but the bridge no longer sets it: the link is inside the wrapper.)
- **Push templates** (3.7, `kind:'system'`, `navigate:'/settings/health'`):
  - `{agent}'s mod stopped reporting`
  - `{agent}'s Mac is back`
  - `Your hourly health check stopped`

  The existing `{agent}'s Mac session stopped` gets the same `navigate`. V2.3 has the rules.

### V1.4 HTTP routes (adds to 3.8; `http.ts` route table)

| Route                                                                               | Auth                                                                                  | Body → response                                                                   | Owner |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----- |
| `GET /api/health`                                                                   | `health-token`: `Authorization: Bearer <HEALTH_TOKEN>`, constant-time; 404 when unset | → `HealthStatus` without `beat`                                                   | WP-V1 |
| `GET /api/status`                                                                   | session                                                                               | → `HealthStatus` with `beat`                                                      | WP-V1 |
| `POST /api/health/test`                                                             | session                                                                               | → 204; one test alert down every configured path                                  | WP-V1 |
| `GET /api/share/tokens` · `POST /api/share/tokens` · `DELETE /api/share/tokens/:id` | session (POST binds the session's pinned `device_id`; none → 403)                     | `{label, scopes}` → `{token, secret}` (secret shown once) / `ShareToken[]` / 204  | WP-V4 |
| `POST /api/share`                                                                   | `share-token`: `Authorization: Bearer talos_share_<43 base64url>`                     | SharePostBody (JSON or multipart) → `202 {share_id}`                              | WP-V4 |
| `POST /bridge/share/tokens`                                                         | bridge-sig                                                                            | `{label, device_id, scopes}` → `{token, secret}` (P1 `share shortcut`)            | WP-V4 |
| `DELETE /bridge/share/tokens/:id`                                                   | bridge-sig                                                                            | none → 204 (204 again when already revoked); unknown id → 404 (P1 `share revoke`) | WP-V4 |
| `POST /share-target`                                                                | none (non-guarded path)                                                               | the SW normally answers; if it reaches the relay, → `303 /share?retry=1`          | WP-V4 |

New auth modes for the route-table enum: `health-token` and `share-token`. New relay env (SPEC 11; `env.ts`, WP-V0):

| Variable                | Default | Notes                                      |
| ----------------------- | ------- | ------------------------------------------ |
| `HEALTH_TOKEN`          | unset   | ≥ 32 chars                                 |
| `ALERT_NTFY_URL`        | unset   | `https://` topic URL                       |
| `ALERT_NTFY_TOKEN`      | unset   | optional bearer for a protected topic      |
| `MOD_QUIET_MIN`         | 10      |                                            |
| `HEALTH_CHECK_STALE_H`  | 3       |                                            |
| `MAC_ALERT_MIN_GAP_MIN` | 120     | minimum gap between two bridge-down pushes |
| `SHARE_ENABLED`         | 1       | 0 = `/api/share*` answers 404              |

---

## V2. Health alarms

### V2.1 Options weighed

| Option                                   | Catches                                          | Misses                                                                                                                                                                                                                                                                                  | Verdict                                        |
| ---------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Relay watchdog → web push                | bridge gone (exists, SPEC 4.1, 5 min), mod quiet | the relay itself; a dead push subscription                                                                                                                                                                                                                                              | **keep and extend**; owns every Mac-side alert |
| GitHub Actions hourly → email on failure | relay down; relay up but unable to alert anyone  | everything for up to an hour. Runs can be "delayed during periods of high loads" and some "may be dropped". In a public repo, schedules are "automatically disabled" after 60 days without activity. Email goes to "the user who last edited the cron syntax" (GitHub docs, `schedule`) | **add**, relay-only                            |
| ntfy topic                               | the same events, through the ntfy app's own push | needs the app; the topic URL is a capability                                                                                                                                                                                                                                            | **optional**                                   |
| Relay-sent email                         | —                                                | needs SMTP credentials                                                                                                                                                                                                                                                                  | **skip**                                       |
| Bridge-side "relay unreachable" alarm    | relay down while the Mac is up                   | sleeping Mac                                                                                                                                                                                                                                                                            | **later**                                      |

**Recommended combo:**
- the watchdog for the Mac;
- the hourly workflow for the relay;
- ntfy optional for both;
- a `Your hourly health check stopped` push when the workflow goes silent.

### V2.2 Bridge (WP-V1, `apps/bridge/src/health/**`)

- **`health.beat`** goes out every 60 s and within 2 s of a change, from the live bridge only.
- **Mod state:**
  - `alive` = a `talos_mod_sync` arrived within 30 s (`src/mod/link.ts`, `MOD_LIVE_WINDOW_MS`).
  - `quiet` = expected but silent.
  - `absent` = not expected.
  - `expected` = kv `mod_seen_at` is within 7 days.
- **The rest of the beat:**
  - `tts` / `stt` say whether a command is configured.
  - `sqlite.fts5` is the V3.1 probe result.
  - `search` / `memory` come from those modules.
- **No content.** No thread names, paths or text.

### V2.3 Relay (WP-V1, `apps/relay/src/core/health.ts`, `alerts-ntfy.ts`)

1. **State.** Keep the last beat, `external_check_last_at`, `last_mac_alert_at` and per-outage flags in store state
   (`setState`), so a redeploy doesn't forget them. `up_since` = process start.
2. **Bridge rule:**
   - `session_stopped` after 5 min, once per outage, and not within `MAC_ALERT_MIN_GAP_MIN` of the previous one. A
     laptop opened and shut five times an evening gets one push.
   - `mac_back` only if a down push went out in that outage, and never in the quiet window.
3. **Mod rule:** bridge online, `mod.expected`, `last_seen` older than `MOD_QUIET_MIN` → `mod_quiet` once per outage.
4. **External check rule:**
   - On a valid `/api/health` call, **first** persist `external_check_last_at = now`, then build the status. The check
     never sees its own staleness.
   - If the timestamp was ever set and is older than `HEALTH_CHECK_STALE_H`, send `health_check_stale`, at most once
     per 24 h.
5. **Delivery rules:**
   - **Mac-side templates** (`session_stopped`, `mod_quiet`, `mac_back`) leave `SYSTEM_TEMPLATES` and **respect the
     quiet window**. A Mac-side alert that falls inside it is held. At quiet-window end it's re-evaluated and sent only
     if the condition still holds, so a laptop asleep all night produces nothing.
   - **Relay-side templates** (`health_check_stale`, `storage_full`) stay in `SYSTEM_TEMPLATES`.
   - **Visible sockets.** All health templates ignore `anyVisible()`, because a visible desktop tab nobody watches must
     not swallow the phone push. A visible app also shows a banner.
6. **ntfy** (if set): the same fixed template text, `Title: {agent}`, `Tags: warning`. Health templates only. Timeout
   5 s, one retry, failures logged without the URL.
7. **Problems:**
   - `relay_problems` = `storage_full` (existing soft cap), and `no_alert_path` (0 push subscriptions **and** ntfy off;
     ntfy-only owners stay green).
   - `mac_problems` = `bridge_offline` (> 5 min) and `mod_quiet` (> `MOD_QUIET_MIN`).
   - `external_check.stale` is shown in the app and is not a workflow failure.

### V2.4 The workflow (WP-V1, `examples/health.yml` + `scripts/health-check.mjs`)

- **Not in the public repo's live workflows.** It ships as `examples/health.yml`, so upstream and forks run nothing.
  `docs/HEALTH.md` makes a **private repo** holding only this workflow the default. The 60-day disable is for public
  repos only, the run history stays private, and 744 one-minute runs a month fit the free 2,000 private minutes
  (INFERENCE from per-job minute rounding). Copying it into a public fork is documented as the alternative, with the
  60-day and public-log caveats.
- **Triggers:** `schedule: cron '17 * * * *'` (off the top of the hour, when load peaks; INFERENCE from the "high
  loads" note) and `workflow_dispatch`. `permissions: {}`, `timeout-minutes: 3`. One step: `curl` the script from the
  owner's talos-app checkout or vendor it (it's a single file with no dependencies), then `node health-check.mjs`.
- **Inputs are secrets only:** `TALOS_HEALTH_URL`, `TALOS_HEALTH_TOKEN`, optional `TALOS_NTFY_URL`. All are masked.
  Not configured → `health check not configured`, exit 0.
- **The script:**
  1. Up to 3 tries 30 s apart (rides out a Railway redeploy).
  2. **Exit 1 only when** the relay is unreachable, answers non-200, fails the `HealthStatus` schema, or has
     `relay_ok:false`. A sleeping Mac, a quiet mod or a stale check → exit 0.
  3. **Output:** `relay ok` / `relay DOWN` / `relay cannot alert`, plus an informational `mac: up` or `mac: down`, no
     times, no versions.
  4. On failure with `TALOS_NTFY_URL` set: post `Talos relay is down` or `Talos relay can't send alerts`.
  5. Never `curl -v`; bodies go to variables only.
- **Setup** (`docs/HEALTH.md`, 4 steps):
  1. `openssl rand -base64 33` → Railway `HEALTH_TOKEN`.
  2. Create a private repo with `examples/health.yml`.
  3. Add secrets `TALOS_HEALTH_TOKEN` and `TALOS_HEALTH_URL`.
  4. Run it once by hand: the Health screen shows "External check: just now".

### V2.5 Web (WP-V1, `apps/web/src/features/health/**`)

**Settings → Health** (`/settings/health`; reachable with the Mac offline, because it's a relay feature):

```
 Health                                   [Send test alert]
 ● Relay          up since 14:02           v0.4.1
 ● Mac bridge     connected · seen just now      (offline: "offline since 22:41", amber; red after 12 h)
 ● Talos mod      reporting · 3 s ago            (absent: "Not installed", grey)
 ● Scheduler      ok                             (cached schedule.status, if schedules/1)
 ○ External check last ran 41 min ago            (never: "Not set up" + link)
 ● Phone alerts   push on this device · ntfy on  (no_alert_path: red "Nobody can be alerted")
 Voice replies need a TTS command on your Mac    ← beat.tts false
 Search is off: this Mac's SQLite has no FTS5    ← beat.sqlite.fts5 false
```

- The screen polls `GET /api/status` every 30 s while visible.
- Home banner on `mod_quiet`, and on `bridge_offline` outside the quiet window.

### V2.6 Acceptance (failing first, real seams)

**Relay** (Vitest; real hub, FakeBridge, FakeApp, a recording PushTransport, a local ntfy sink, injected clock):
- **Bridge down:**
  - Bridge gone 5 min → one `session_stopped`, with a visible socket present.
  - Back → one `mac_back`.
  - Gone again 30 min later → **no** push (min gap).
  - Gone inside the quiet window → nothing in the window; still gone at its end → one push; back before the end →
    nothing at all.
- **Mod:** quiet 11 min → one `mod_quiet`, not repeated.
- **`/api/health` auth:** unset env → 404; a wrong token → 401 (constant time); right → schema-valid, no thread names,
  no `beat`.
- **Health status:**
  - With the bridge offline 6 h → `relay_ok:true`.
  - 0 subscriptions, ntfy on → `relay_ok:true`; ntfy off → `no_alert_path`.
  - After a 4 h gap, the next check's own response has `external_check.stale:false`.
  - After a simulated redeploy (new hub, same store), the stale rule still fires.
- **ntfy:** the sink gets only fixed strings.

**Bridge** (real bridge, FakeRelay, scripted `talos_mod_sync`):
- `alive` → `quiet` at 31 s.
- `expected` survives a restart.
- The beat has no path.

**Script** (`scripts/health-check.test.ts`, the real script against an in-process real relay):
- **Exit 0:** ok; bridge offline 6 h; mod quiet; no URL.
- **Exit 1:** relay stopped; a 500; `relay_ok:false`.
- Output never contains the token, the URL, or a digit run from the body.

**Web:** every row state; works with the bridge offline (relay feature); the test button; axe clean.

---

## V3. Search

### V3.1 Bridge index (WP-V2, `apps/bridge/src/search/**`)

**SQLite and API.**
- `bun:sqlite`'s `Database` loads **macOS's system `libsqlite3`** (3.51.0 on 26.7.1). Bun's `Database.setCustomSQLite()`
  is the documented escape hatch; it isn't used in v1. Calls used:
  - `new Database(path)`;
  - `db.query(sql).all/get/run(...)`;
  - `db.run(sql)`;
  - `db.transaction(fn)` (BEGIN/COMMIT, ROLLBACK on throw).
- **Start probe** (live bridge, CLI `doctor`): `CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x)`, then drop it.
  Failure → `sqlite.fts5:false`, `search/1` and `memory/1` are not advertised, and `doctor` prints "This Mac's SQLite
  has no FTS5; search and the memory browser are off". The ranking needs no SQL math functions (V3.1, ranking).

**Schema** (`search/schema.ts`; `CREATE ... IF NOT EXISTS`, run by **every** process that opens the store, inside the
indexer's own try):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
  text, transcript, names, files, card,          -- one column per match_in value
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
-- rowid = messages.ord. Filters join messages(thread_id, author, created_at). No change to the messages table.
CREATE TABLE IF NOT EXISTS fts_files (media_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, state TEXT NOT NULL);
-- kv keys (existing kv table): search_hwm (highest ord indexed), search_dirty ('1' = rebuild needed)
```

**What goes in each column:**

| Column       | Content                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`       | message text                                                                                                                                                      |
| `transcript` | `transcript.text`                                                                                                                                                 |
| `names`      | attachment names, excluding `voice_reply`                                                                                                                         |
| `files`      | text attachment contents (mime `text/*`, `application/json`, or `.md .txt .csv .log .json .yaml .yml`; ≤ 1 MiB; first 200 KB; the bridge's own media folder only) |
| `card`       | card title and summary, a hook row's title and summary, an app row's label and tool name (never inputs or results, MCP-Apps M4.8)                                 |

**Isolation (the message write can never fail because of search):**
1. **Single opener.** V0 adds `openHistory(path)` in `history-store.ts`. Both openers (`bridge.ts:103`, `cli.ts:267`)
   switch to it, and it calls `installSearchIndex(store)` from `src/search/install.ts` (a V0 stub that WP-V2 fills).
   No call site can forget.
2. **Post-commit hook.** V0 adds `HistoryStore.onWrite(fn)`. The four write methods (`addMessage`, `setSeq`,
   `updateTranscript`, `pruneOld`) keep their current statements unchanged, and call listeners **after** their
   statement has committed, with `{op:'upsert'|'transcript', ord, msg}` or `{op:'prune', before_iso}`. `setSeq` isn't
   forwarded: seq isn't indexed.
3. **Indexer transaction.** The listener applies the change in **its own** `db.transaction()` (delete the rowid, then
   insert). It's wrapped in try/catch. On any error, that transaction rolls back alone; the indexer sets kv
   `search_dirty=1` (in its own try/catch) and logs `warn` with no text. It then updates `search_hwm`.
4. **Reconcile** (live bridge tick, every 30 s):
   - rows with `ord > search_hwm` are indexed, 500 per tick. That covers a crash between commit and index, and a
     headless writer whose index failed.
   - `search_dirty=1` → drop and rebuild in 500-row ticks, `index:'dirty'` until done.
   - A weekly rebuild (Sunday 03:00 local) catches transcript updates lost to a crash. `talos-app search reindex`
     forces one.
5. **File contents** are indexed by the live bridge only, 20 files per 5 s tick, never on the inbound queue.

**Queries** (`fts-query.ts` in the protocol, shared with V5; raw input never reaches `MATCH`):
- **Terms.** Split on whitespace, keep `"phrases"`, ≤ 12 terms, each an FTS string literal with `"` doubled. The last
  bare term of 2 or more characters gets `*`. `-word` → `NOT "word"`, never alone: a NOT-only query is an FTS5 syntax
  error, so it's dropped.
- **Ranking, `relevance`** (fixed in rev 2; bm25 is lower-is-better):
  1. SQL takes the top 200 candidates by
     `ORDER BY bm25(msg_fts, 4.0, 3.0, 2.0, 1.0, 1.5) ASC` (text, transcript, names, files, card).
  2. JS re-ranks them by `score = (−bm25) / (1 + age_days / 30)` **descending**, ties broken by `created_at` newer
     first. A hit from today with the same relevance as one from a month ago scores about 2×.
  3. The cursor is an offset into the re-ranked 200, which is the cap for relevance results.
- **Ranking, `newest`:** keyset on `messages.ord DESC`, up to 1000 results.
- **`has_file`** at query time, with no schema change:
  `EXISTS (SELECT 1 FROM json_each(m.json,'$.attachments') a WHERE json_extract(a.value,'$.role')='attachment' AND json_extract(a.value,'$.kind')!='voice_note')`.
  Voiced replies never count.
- **`match_in`** for the page's hits (≤ 50): `highlight()` with the sentinels U+E000/U+E001 is run per column, in the
  order text, transcript, names, files, card. The first column holding a sentinel wins, and its `snippet()` becomes the
  snippet. Sentinels already in the source are stripped first. `marks` are the offsets after stripping.
- **Cursor:** base64url of `{offset|ord, sort, qhash}`. A cursor for a different query → `bad_query`.
- **Retention:** history keeps 90 days (`MESSAGE_RETENTION_MS`). WP-V2 adds `TALOS_APP_HISTORY_DAYS` (default 90,
  `0` = text forever, media still pruned), V10 Q1.

### V3.2 Relay and app

- **Relay:** nothing beyond V0's router, plus forwarding of the three new `history.request` keys.
- **Jump to message: a context view, never merged into the live timeline.**
  - A hit opens `/t/:thread?m=<id>`. WP-V2's `features/search/ContextView.tsx` renders it **instead of** the live
    timeline: read-only, the same `MessageView`, from `history.request{around_id, limit:50}` (25 each side).
  - The bar at the top reads "Showing a past conversation" with [Jump to latest].
  - **Older:** `history.request{before_id: <oldest shown>}`. **Newer:** `history.request{after_id: <newest shown>}`
    (the bridge pages on `ord`), until `has_newer:false`. Then the view says "You're up to date" and [Jump to latest]
    becomes primary.
  - The anchor is highlighted for 1.2 s. The composer is hidden (replying from the past is ambiguous); [Reply in
    thread] jumps to latest with `reply_to` set.
  - **Ownership.** `ThreadScreen` switches to `ContextView` when `?m=` is present. That's one line V0 adds. Neither
    `socketClient.ts` nor `Timeline.tsx` changes.
- **Offline:** on `mac_offline`, the app does a folded substring search over its cached messages, labelled "Your Mac is
  offline. Showing matches from messages on this device." The context view then works only inside the cached range.

### V3.3 UI (WP-V2, `apps/web/src/features/search/**`)

```
 ← [ Search messages…            ✕ ]
 [All threads ▾] [Anyone ▾] [Has file] [Any time ▾]  Best match ⇅ Newest
 ──────────────────────────────────────────────
 # Projects · You · Tue 14:02                         in message
   …draft the **release** notes for v0.3…
 # General · Talos · 2 Oct                    📎 notes.md · in file name
   **release**-notes.md
 # Inbox · You · 1 Oct                                 in voice note
   …remind me about the **release** party…
 ──────────────────────────────────────────────
 Building the search index on your Mac… some results may be missing
```

- **Match badge:** `text` → "in message", `transcript` → "in voice note", `attachment_name` → "in file name",
  `attachment_text` → "in file", `card` → "in card".
- **Entry:** the Home header icon (SPEC 8.2), the sidebar, and `Cmd+K` (added to `lib/useKeyboard.ts` by **V0**;
  `Cmd+Shift+K` stays "call"). SPEC 8.8's v1.1 palette takes another key.
- 300 ms debounce, 2 characters minimum, the last 10 queries per device. `<mark>` is built from `marks` over text
  nodes only.

### V3.4 Limits and acceptance

**Limits:**
- `search.query`: **120/min** per socket (typing makes 5 or 6 queries per search).
- A 1.5 s budget per query, then `search_unavailable`.
- Results byte-fit.

**Bridge** (real bridge, FakeRelay, 5,000 generated messages):
- **Isolation:**
  - **Drop `msg_fts` behind the bridge's back, then write a message → the message is stored**, `search_dirty=1`, and
    the next reconcile rebuilds.
  - A headless process writing with no FTS table creates it, or else fails silently into dirty.
  - A crash simulated between commit and index → the reconcile indexes the message by the high-water mark.
- **Ranking and matching:**
  - **Equal relevance → the newer hit first.**
  - The same word in the text of an old message and of a new one → the new one first.
  - `match_in` is `transcript` for a voice note hit, `attachment_name` for a file-name hit, `text` otherwise.
- **Filters and query safety:**
  - `has_file:true` excludes a message whose only attachment is a voice reply.
  - A `"`, `NEAR(` or a lone `-x` is literal or dropped, never a syntax error.
- **Context paging:** `around_id`, `before_id` and `after_id` page correctly by `ord`.
- **Share and app rows:**
  - A share stored by the bridge is findable.
  - An app row's tool result is not.
- **Probe:** with no FTS5 (injected by a shim that fails the probe) → `search/1` is not advertised.
- **Signatures:** bad signature → `sig_invalid`, no results.

**Web** (FakeRelay replaying `packages/testkit/fixtures/captured/search/`):
- marks render, and `<img>` in a snippet is text;
- a hit opens the context view, and Older, Newer and Jump to latest work;
- the live timeline is unchanged after returning;
- offline fallback; axe clean.

---

## V4. Driving mode and share to Talos

### V4.1 Driving mode: behaviour

- **Toggle** (Settings → Voice, `/drive`, and the thread header overflow):
  - On sends `config.patch {voice_notes:{driving_until: now + 2 h}}`. While `/drive` is open, the app re-extends when
    less than 30 min is left.
  - Off sends `null`.
  - On `config_conflict` (another device changed the config), re-read `config.sync` and retry once. Then show "Couldn't
    change driving mode. Try again."
- **Bridge** (V0 implements it, in `send.ts`, `notify.ts` and `server.ts`):
  1. `wantVoiceReply()` decides.
  2. **In driving mode the text reply goes out at once.** The voice is then synthesized from
     `spokenText(text, voice_text)` (plain text, external wrappers removed, the Codex rule applied) and sent through
     the existing attach path as a follow-up message, sent `silent`, with a `voice_reply` attachment and `reply_to` the text message.
     A slow TTS never holds the reply or the agent's tool call.
  3. Outside driving mode, today's behaviour is kept (`markdownToPlain` is applied there too).
  4. Owner-trust notifications get meta `driving="true"`.
  5. Instructions line: "When `driving` is `true`, the owner is listening, not reading: answer in at most three short
     spoken sentences and give the spoken version as `voice_text`, with no tables, code or links in it. Cards still
     wait for a tap; say that one is waiting."
- **Web autoplay:**
  - One `HTMLAudioElement` is unlocked by the toggle tap (a 50 ms silent clip). Web Audio isn't used: WebKit 291892 is
    "WebAudio AudioContext silent after PWA returns from background, even after resuming it".
  - `navigator.audioSession.type`, where it exists: `'playback'`, switched to `'play-and-record'` while recording a
    voice note, then back.
  - Voice replies from any thread go into a FIFO at the saved speed (`speed.ts`). Recording pauses playback.
  - No voice within 20 s of a text reply → `speechSynthesis` reads `spokenText(text)` if "Use the phone's voice as a
    fallback" is on (the default).
  - **Only the device that is driving reads aloud:** the one whose tap turned driving on, or that has `/drive` open
    (kept across a relaunch while `driving_until` is still the window it claimed). Other open devices show the replies
    and stay silent. Owner-reversible default (re-check 2026-10-30).
  - **One voice at a time, every wait bounded:** a clip that hasn't started 8 s after it was asked to (hung download,
    `play()` that never settles), or makes no progress for 10 s mid-way, is given up: "Couldn't play that reply", or the
    text is read if the clip had already started. A clip waits for the phone voice to finish an earlier reply, at most
    45 s. A live call holds clips and the phone voice until it ends.
- **Foreground only:** iOS suspends a backgrounded Home Screen app's JavaScript, so no new reply can start. Whether
  audio already playing continues is SMOKE V9.3 (there are mixed reports; WebKit 237878, the AudioContext case, is
  fixed). From a push, `/drive` opens and plays on one tap of the big Play button. Screen Wake Lock is held (installed
  web apps from iOS 18.4, per firt.dev), and Media Session metadata and handlers are set.

### V4.2 Driving mode: UI (WP-V3, `apps/web/src/features/drive/**`, `/drive`)

```
 ┌──────────────────────────────┐
 │  ● Driving · General ▾        │  thread chip (tap cycles fixed threads)
 │      Speaking… 0:12 / 0:31    │  Listening · Sending · Thinking · Speaking · Ready
 │   "Done. Three sections…"     │  first line, 28 px, 2 lines max
 │   [⟲ 10s]  [ ❚❚ ]  [ ⏭ ]       │  96 px targets
 │            1.5×               │
 │        (   HOLD TO TALK   )   │  140 px; tap-to-toggle in Settings
 │  1 card waiting · approve later   [Exit]  │
 └──────────────────────────────┘
```

- Dark always, 22 px minimum text, no scroll, haptics through `platform.ts`.
- Cards and permission requests are counted and spoken once ("{agent} is waiting for an approval"), never approved
  here.
- "Talk live" appears when live voice (SPEC 6) is configured. While a call is up it becomes a 96 px "End call", and Exit
  ends the call too (nothing behind `/drive` can).

### V4.3 Share (WP-V4)

**Shortcut tokens: the minimum capability.**
- A token can call **one route** (`POST /api/share`) and land **one kind of row**: an Inbox message with
  `trust=external`.
- No thread choice. No read of anything. No fetch, memory write or tool runs on its own.
- **Scopes:** `text` (always) and `files` (opt-in at creation, the "Allow photos and files" switch, off by default).
- **Security properties:**
  - hashed at rest (`sha256(secret)`);
  - shown once;
  - bound to the creating device (a lookup joins `devices`, so a revoked device's tokens fail without touching WP2's
    revoke handler);
  - 10 active per relay;
  - revocable in Settings or with `talos-app share revoke <id>`.
- **Visibility:** the token list shows `last_used_at` and `last_used_net` (IPv4 /24 or IPv6 /48), so use from a
  stranger's network shows up.

**Create** (Settings → Share from other apps → [Create a share link], label, optional files switch): `POST
/api/share/tokens` → secret `talos_share_<base64url 32 B>`, shown once with [Copy].

**Recipe** (in the app, with copy buttons, and in `docs/SHARE.md`):
1. _Receive_ Text, URLs, Safari web pages (and Images and Files if the token allows them) _from_ Share Sheet.
2. (optional) _Ask for Input_ "Note for {agent}".
3. _Get Contents of URL_: `https://<host>/api/share`, POST, Header `Authorization` = `Bearer <secret>`, Form: `text` =
   Shortcut Input (as text), `file` = Shortcut Input, `note` = Provided Input.
4. _Show Notification_ "Sent to {agent}".

**P1: `talos-app share shortcut --label <l> [--files]`.**
- Mints a **fresh token per export**, labelled `<l> (exported <date>)`, through `POST /bridge/share/tokens`.
- Writes the plist and runs `shortcuts sign --mode anyone` (present on macOS 26.7.1; needs iCloud sign-in; INFERENCE
  that Apple's signing service sees the file).
- Posts the `.shortcut` into the default thread. (Not built in Share P1: the file stays in `$TALOS_APP_HOME/shortcuts/`
  and the command prints where. Built: `share revoke <id>` over `DELETE /bridge/share/tokens/:id`, which is idempotent.
  `shortcuts sign` reads only a file named `*.shortcut`, so the unsigned recipe is written as `*.unsigned.shortcut`, and
  it wants `WFWorkflowClientVersion` as a string. Checked on macOS 26 on 2026-10-29. Not tested on an iPhone.)
- `docs/SHARE.md`: "The file contains the key. Forwarding it forwards the key. Revoke it from Settings if it leaks."

**Relay `POST /api/share`:**
1. 10/min per IP before lookup.
2. Look up the hash joined to the device: not found, revoked, or device revoked → 401 `share_token_invalid`.
3. 30/hour per token.
4. Parse: file parts without the `files` scope → 403. ≤ 4 files of 20 MB, stored with a server sha256.
5. Non-empty rule: text, url, note or ≥ 1 file. A photo-only share is valid.
6. Build the Message: author `owner`, via `share`, thread `inbox`, `text` = note, `share_content` = {text, url, title}.
   Store it, emit it, send `share.item`, update `last_used_*`.
7. Answer `202 {share_id}`.

**Signed `/share` page** (Android `share_target`, bookmarklet, `?text=&url=&title=`):
- **Android and Chromium:** the manifest has `share_target: {action:'/share-target', method:'POST',
  enctype:'multipart/form-data', params:{title, text, url, files:[{name:'files', accept:['image/*','text/*',
  'application/pdf','audio/*','video/*']}]}}`. The service worker catches the POST, keeps files in IndexedDB
  (`share-pending`, 24 h), and answers `303 /share?pending=<id>`.
- `/share` shows the **shared material read-only in a "Shared content" box**, a note field ("What should {agent}
  do?"), a thread picker, and [Send]. The result is a signed `message`: `text` = the note only, `share_content` = the
  material, plus attachments. The shared title, text and URL never enter `text`.
- **Bookmarklet:** `javascript:location='https://<host>/share?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)`.

**Bridge** (`src/share/**`; the notification shape is V0's):

| Path                          | Notification                                                                                                                                       | Agent may                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shortcut token (`share.item`) | kind `share`, **trust `external`**, thread `inbox`. The note **and** the content are inside one `wrapExternal` block (source "Shared via {label}") | what the SPEC 3.6 external rule allows: summarise, triage, propose a card. The bridge has already filed it in the shared inbox (zero taps); the agent never saves it again |
| Signed `/share` page          | kind `text` (or `file`), **trust `owner`** for the note. The content is inside a `wrapExternal` block (source "Shared page")                       | act on the note as owner words; the content is data                                                                                                                        |

Meta: `share_id`, `share_source`, files as `file_path*` (never `file_name`: a shared file's name is a stranger's text and rides inside the wrapper). The bridge stores the Message in
`history.sqlite` either way.

### V4.4 Share: UI

- Settings → **Share from other apps**:
  - the token list (label, device, scopes, last used with its network, [Revoke]);
  - [Create a share link], the recipe, and a platform note. iOS: "iPhone can't add web apps to the share sheet yet, so
    this uses a Shortcut. What it sends arrives in Inbox as something to look at, not as an instruction."
- Inbox rows from a token show "Shared via {label}" with the content box.

### V4.5 Limits

| Thing                  | Limit                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| share tokens           | 10 active                                                                                     |
| `POST /api/share`      | 10/min/IP before lookup, 30/hour/token, 4 files × 20 MB (files scope only), text 32k, note 4k |
| `driving_until`        | ≤ now + 12 h (bridge, `config-file.ts`); app sets 2 h                                         |
| spoken text            | 1,500 chars after `spokenText()`                                                              |
| `/share` pending files | 24 h                                                                                          |

### V4.6 Acceptance

**Bridge** (real bridge, FakeRelay, FakeClaude, a fake TTS that sleeps 5 s):
- **Driving mode:**
  - Driving active + policy `never` → the text `reply` frame reaches FakeRelay **before** the TTS finishes. A
    follow-up message with `voice_reply` and `reply_to` follows.
  - The TTS input has no `#`, `|`, backticks or wrapper markers.
  - A reply that's 60% code fences → spoken "Details are in the thread."
  - Notifications carry `driving="true"` only while active.
- **Shares:**
  - A token `share.item` → trust `external`, note and content both inside the wrapper, a forged end marker replaced,
    the Message stored in `history.sqlite`.
  - A signed `/share` message with `share_content` → trust `owner`, and the content is inside a wrapper.
  - A replayed `share.item` is notified once.

**Relay:**
- **Tokens:** create without a pinned device → 403; the secret is absent from the DB file; a wrong token → 401; a
  revoked device → 401 (join).
- **Posts:**
  - 31st/hour → 429.
  - A file without the `files` scope → 403.
  - **A photo-only multipart post with the `files` scope → 202.**
  - A post naming a thread is impossible (`.strict()` → 400).
- **Rows:**
  - The Message thread is `inbox`.
  - `last_used_net` is the /24.
  - `share.item` is replayed until `consumed`.
  - `SHARE_ENABLED=0` → 404.

**Web** (Playwright `iphone`, `pixel`, `desktop`):
- **Driving mode:**
  - The toggle → one signed `config.patch`; a forced `config_conflict` → one retry.
  - A voice follow-up autoplays after the toggle tap.
  - No voice in 20 s → `speechSynthesis.speak` (stubbed).
- **Share page:**
  - **The `pixel` share-target test uses a form-submit navigation** (a POST multipart `<form>`), not `fetch()`, and
    lands on `/share` with the file.
  - **The shared title and text render only in the content box. The sent signed frame has them in `share_content`, and
    `text` equals the typed note.**
  - The bookmarklet URL prefills.
- **Doc test:** the doc's recipe uses `file`, the manifest uses `files`, and both match the parser.

### V4.7 Trust for shares

- **Shared material is always external,** on every path.
- **Owner words.** The only owner words are a note typed inside the signed app. A note typed in a Shortcut is external
  too, because a Shortcut can't sign.
- **What a leak costs:**
  - **A leaked share URL** gives away the relay host only: the secret travels in the `Authorization` header.
  - **A leaked token** lets its holder put rows into Inbox that the agent treats as data. That means one card at most,
    and nothing happens without the owner's tap, until the owner revokes it.
- **The cost to the owner** is nothing for "save this": the bridge files every token share. Summarising, triaging and
  drafting stay free; only side effects take a tap (V10 Q3).

---

## V5. Memory browser

### V5.1 Configuration (Mac only; WP-V5)

`$TALOS_APP_HOME/memory.json` (0600):

```json
{
  "version": 1,
  "enabled": true,
  "agent_dir": "/abs/path/to/agent",
  "roots": [
    { "id": "notes", "label": "Notes", "path": "notes", "include": ["**/*.md", "**/*.txt"], "exclude": ["drafts/**"] }
  ],
  "max_file_kb": 512
}
```

- **One switch rule:** the browser is on iff `memory.json.enabled && config.memory_browser`.
  - The phone can only turn it off (`config.patch {memory_browser:false}`).
  - `talos-app memory init` and `talos-app memory on` set both to true locally: the CLI writes `config.json` directly,
    as other CLI commands do, and the live bridge picks the change up through its existing config watch.
  - `memory off` sets both to false.
- **`memory init [--agent-dir <dir>]`:**
  1. Lists top-level folders with markdown counts and asks y/N per folder.
  2. **For each chosen folder, it lists its subfolders with counts** and asks "Exclude any? (comma-separated, Enter
     for none)".
  3. Shows the effective lists, the denylist hits and any `.talos-private` folders found.
  4. Writes the file. `memory show` prints exposure (counts per root, first 20 paths).
- **Validation:** root paths realpath inside `agent_dir`. `agent_dir` may not be `/`, `$HOME` or `$TALOS_APP_HOME`.
  `Bun.Glob` matching.
- **Never exposed** (`src/memory/deny.ts`; config can't override it; every path segment; case-insensitive):
  - `.*`, `node_modules`, `__pycache__`, `venv`;
  - `*.pem`, `*.key`, `*.p12`, `*.keychain*`, `id_rsa*`, `id_ed25519*`, `*.kdbx`;
  - **`*.env`**, **`credentials*`**;
  - `*.sqlite*`, `*.db`, `.mcp.json`, `settings*.json`;
  - files over 5 MB;
  - **any folder containing a `.talos-private` file, and everything under it.**

  Symlinks show only if their realpath stays in the root. Everything out of scope answers `memory_not_found`.

### V5.2 Bridge (`apps/bridge/src/memory/**`)

- **Index:** `$TALOS_APP_HOME/memory-index.sqlite` (derived).
  - `mem_fts(title, body)`, using the same tokenizer and `fts-query.ts`, the V3.1 probe, and the same isolation (it's a
    separate DB, so an index failure can't touch history).
  - `title` = frontmatter `title:`, else the first `# `, else the file name.
- **Freshness:** a scan at start; `fs.watch(root, {recursive:true})` debounced 2 s; a 5-min mtime/size poll; rebuild
  when `memory.json` changes.
- **Caps:** 20,000 files, 200 MB of text, `max_file_kb` per file. Over a cap → `truncated`.
- **Frames byte-fit** (V1.3), using the `history.page` loop (`inbound.ts`, the "relay hangs up" comment):
  - **Listing:** entries are added until the frame would exceed `MAX_FRAME_BYTES − 2 KiB`, then `next_cursor` (the
    last name). The app loads more on scroll.
  - **File:** links first (capped at 128 KiB encoded; dropped first when room is short), then text cut to the remaining
    room on a code-point boundary, with `next_offset`. The app loads the next chunk on scroll. At 256 KiB frames that's
    about 200 KiB of plain text per chunk, and less for quote- and newline-heavy text, which is why it's measured
    encoded.
- **Links:** `[[name]]` and `[[name|alias]]` resolve to the first visible `name.md` in the same root (nearest folder
  first), then other roots. Relative `.md` links resolve against the file. **A target that fails deny, private, include
  or exclude resolves to `path:null`,** exactly like a missing one, so links never reveal hidden notes.
  **What is a link** is one rule in `packages/protocol/src/memory-links.ts`, run by the Mac to build the list and by the app
  to read the note again: fenced blocks (to their closing fence or the end of the note), indented code, inline code spans,
  list items, quotes and table cells as their own paragraphs. Links in code are not links. The list holds each distinct
  link once, properties first, then the body, in the order it first appears. The wire shape is unchanged. The app pairs its
  own reading with the list in order, checking each entry's label and file name; against an older Mac, or a note that
  changed, a link takes an entry only when exactly one entry fits and no other link could claim it, and otherwise stays
  plain text. The renderer (markdown-it) decides what is code on the page; the app never writes a placeholder address into
  the note text.
- **`refs`:** re-checked; meta `memory_root`, `memory_path` (absolute), and `memory_changed` if the sha differs. A ref
  that's no longer allowed is dropped, with the system note "That note isn't shared any more."
- **Queue:** signed memory reads go on the `readQueue`. Nothing is ever written under the agent dir. Logs carry ids and
  counts only.

### V5.3 UI (WP-V5, `apps/web/src/features/memory/**`, `/memory`)

```
 Memory          [ Search notes…        ]
 Notes ▸ projects ▸ example-project
 📁 decisions
 📄 Overview             2 d
 📄 Launch checklist     5 h
```

- **Note view:** a header with the path, the edit age and [Ask {agent}]; frontmatter as a small table; markdown through
  `lib/markdown.ts` (raw HTML as text; `.html` as source; never `SandboxedFrame`). Resolved links navigate; null links
  are grey. Long notes load more on scroll.
- **Search:** `HitRow` from `features/search/`, with V0's placeholder until WP-V2 lands.
- **[Ask {agent}]:** thread picker, then a signed `message` with `refs`.
- **Offline:** the last 20 opened notes (first chunk) and the visited listings, labelled "Saved on this device ·
  <time>". Cleared on logout. Reachable through last-known features (V1).
- **Off:** "The memory browser is off. Turn it on at your Mac: `talos-app memory on`."

### V5.4 Limits, security, acceptance

- **Limits:** `memory.*` 60/min per socket; frames byte-fit; a search budget of 1.5 s.
- **Security:**
  - off by default; configured on the Mac; the phone can only turn it off;
  - signed reads; read-only;
  - the denylist, the private marker, realpath containment, and links that don't leak;
  - the relay never stores memory frames.
  - **Honesty line (V7):** a compromised relay sees the notes the owner opens, in transit, just as it sees chat.
- **Acceptance** (real bridge on a temp agent dir; FakeRelay **plus one run against the real relay**, so the hang-up
  rule is exercised):
  - **Off:** no `memory.json` → `memory_off`. After a phone `memory_browser:false` → `memory_off`; `memory on` at the
    Mac restores it.
  - **Hidden paths:** `.env`, `a/.git/config`, `x.pem`, `prod.env`, `credentials.json`, `notes.sqlite` and a folder
    with `.talos-private` are all invisible, and a direct read gets `memory_not_found`. `../x` and absolute paths fail
    the schema. A symlink out of the root is hidden. An `exclude` glob applies to tree, read and search.
  - **Frame caps** (both stay under `MAX_FRAME_BYTES` against the real relay, which doesn't hang up):
    - 500 entries with 255-byte names and 400-byte paths → paged across frames;
    - a 192 KiB note full of `"` and `\n` with 200 long links → chunked;
    - reassembled chunks equal the file and its `sha256`.
  - **Links:** **a link to an excluded or private note resolves `path:null`.** `[[Overview]]` resolves.
  - **Freshness:** a new file is searchable within 3 s (watch), and within 5 min with watch off (poll).
  - **`refs`:** a message with refs → `memory_path`; after an edit → `memory_changed`; a ref to a now-excluded note is
    dropped, with the system note.
  - **No writes:** the agent dir's hash is unchanged after the suite.
- **Web:** tree, chunked note, frontmatter, links, Ask sends signed `refs`, offline cache, `<script>` as text, axe.

---

## V6. Interactions with in-flight work

| In flight                                                                                            | Interaction                                                                 | Rule                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Protocol PRs** (S0, C0.5 merged; MCP-Apps AP0 queued)                                              | AP0 edits the same protocol files                                           | V frames live in new files, spread in one line each. The second of AP0 and V0 to merge rebases; only list lines conflict                                                                                                                                                            |
| **Schedules** (S1-S4)                                                                                | S2 builds a request map and the features echo; S3 edits `Nav.tsx`/`App.tsx` | V0's `core/ephemeral.ts` is **the** router (V1.3). The features echo is S2's, with V0 as fallback. V0 adds the `/search`, `/memory`, `/drive`, `/share`, `/settings/health` routes and nav items once; V builders never touch those files. Health shows the cached scheduler health |
| **Session panel** (C3), **mod** (C2)                                                                 | Mod liveness comes from the existing mod link                               | The C3 sheet's "Health ›" link goes under `## Requests` to WP-C3 (no V package owns that file)                                                                                                                                                                                      |
| **Permission cards** (C1)                                                                            | Driving with a pending prompt                                               | `/drive` counts it and speaks it once; it's never approved from there                                                                                                                                                                                                               |
| **Codex delegate** (C5)                                                                              | "Codex:" replies                                                            | Searchable as agent rows. Spoken through `spokenText()` (V0): wrappers removed, the code-heavy rule                                                                                                                                                                                 |
| **MCP Apps** (AP1-AP4)                                                                               | App rows; AP1 edits `history-store.ts`                                      | Only label and tool name are indexed. V0's history edits are small (`openHistory`, `onWrite`, post-commit calls), with no schema change; AP1 rebases on them or the other way round. Notes never use `SandboxedFrame`. `/drive` counts `app_action` cards                           |
| **Hot bridge files** (`inbound.ts`, `notify.ts`, `cli.ts`, `server.ts`, `send.ts`, `config-file.ts`) | Edited by S1, C3, AP1                                                       | V0 makes every V edit in them: dispatch lines, `readQueue`, meta keys, instructions, the driving send path, config rules, CLI stubs. Builders own only their folders                                                                                                                |

---

## V7. Security summary (adds to SPEC 10.4 and docs/SECURITY.md)

| Surface            | Risk                             | Answer (lightweight)                                                                                                                                             |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health`      | leaks state                      | Token-gated. No names or text. Runs in a private repo by default; the output is up/down words                                                                    |
| Workflow           | secret in a log                  | Secrets masked, no `-v`, a test asserts it                                                                                                                       |
| Search, memory     | relay reads the Mac              | Signed reads, never stored, `memory_not_found` for anything out of scope. A compromised relay still sees what the owner opens, in transit, as with chat          |
| Memory exposure    | wrong folder                     | Off by default, Mac-only, subfolder excludes, `.talos-private`, the denylist, links that don't leak, read-only                                                   |
| Share token        | leak or theft                    | One route, Inbox only, external trust, files opt-in, hashed, device-bound, rate-limited, last-used network shown, revocable. Worst case: untrusted rows in Inbox |
| Shared material    | prompt injection through a share | Always wrapped external on both paths. Only a note typed in the signed app is owner words                                                                        |
| Snippets and notes | injection into the app           | `marks` offsets, never HTML; the existing sanitizer                                                                                                              |
| Search index       | breaks message writes            | Post-commit, its own transaction, dirty flag, reconcile (V3.1)                                                                                                   |
| Driving mode       | stuck on                         | 2 h expiry, 12 h clamp                                                                                                                                           |

---

## V8. Work packages

**Order:** WP-V0 (merged) → WP-V1, V2, V3, V4, V5 in parallel → WP-V6. Failing tests come first, with the red run pasted
in the PR. The real seams are:
- **Bridge:** the real process with FakeRelay and FakeClaude.
- **Relay:** the real hub with FakeBridge and FakeApp.
- **Web:** Playwright against captured frames, with per-feature capture folders
  (`packages/testkit/fixtures/captured/search/` and `captured/memory/`, each with its own `index.json`), re-checked in
  CI with `--check`.

### WP-V0: protocol, seams, every hot-file edit (architect, ~2 days)

**Owns:**
- **Protocol:**
  - new `health.ts`, `search.ts`, `memory.ts`, `share.ts`, `driving.ts` (with `spokenText`, and `markdownToPlain`
    moved in), and `fts-query.ts`;
  - the V1 edits to `frames.ts`, `models.ts`, `config.ts`, `errors.ts`, `http.ts`, `push.ts`, `channel-meta.ts`,
    `ids.ts`, `index.ts`;
  - fixtures.
- **Relay:** `env.ts`; `core/ephemeral.ts` (the shared router, implemented, with S2's map lifted in if it has merged);
  `hub.ts` dispatch; the `ready.features` and last-known `presence.features` (or a `## Requests` to S2); `auth/limits.ts`.
- **Bridge:**
  - `history-store.ts` (`openHistory`, `onWrite`, post-commit calls), with `bridge.ts` and `cli.ts` switched to
    `openHistory`;
  - `src/search/install.ts` stub;
  - `inbound.ts` (dispatch, `readQueue`);
  - `notify.ts` (meta, share notification shape), `server.ts` (instructions), `handshake.ts` (features);
  - `tools/send.ts` (driving send path), `config-file.ts` (the two rules);
  - `cli.ts` stubs.
- **Web:** `lib/client.ts`, `fakeClient.ts`, `lib/useKeyboard.ts` (`Cmd+K`), registry placeholders, `App.tsx` routes,
  `Nav.tsx` items, the `ThreadScreen` `?m=` switch.
- **Testkit:** fakes, `contract/ephemeral-frames.ts`.
- **Docs:** SPEC table edits.

**Acceptance:**
- **Protocol:** fixtures parse; owner frames are strict with no defaults; `MemoryPath` rejects bad paths; the
  `fts-query` property test (random input never throws in a real FTS5 `MATCH`).
- **Pure functions:**
  - the `wantVoiceReply` and `spokenText` tables;
  - `SharePostBody` accepts an empty body when files are counted;
  - **`onWrite` listener throws → `addMessage` still committed**;
  - `openHistory` installs the indexer from both openers.
- **Integration:** the router contract passes against the real relay; relay features reach the app with the bridge
  offline.
- **Personal data:** `check:personal` passes.

### WP-V1: health (~2 days)

- **Owns:** relay `core/health.ts`, `core/alerts-ntfy.ts`, `core/push.ts` (template sets, the `visible` exemption, quiet
  hold), the route handlers; bridge `src/health/**`; `examples/health.yml`, `scripts/health-check.mjs` and its test; web
  `features/health/**`; `docs/HEALTH.md`.
- **P0:** V2.2-V2.5.
- **Acceptance:** V2.6.

### WP-V2: search (~3 days)

- **Owns:** bridge `src/search/**` (schema, probe, install, indexer, reconcile, query, around, file indexer), `search
  reindex`, `TALOS_APP_HISTORY_DAYS`; web `features/search/**` (`HitRow`, `ContextView`); `captured/search/`.
- **P0:** V3 without file contents.
- **P1:** file contents, recent queries.
- **Acceptance:** V3.4.

### WP-V3: driving mode (~2 days, web only)

- **Owns:** `features/drive/**`, the Settings → Voice row, the queue, and the wake-lock, media-session and audioSession
  adapters in `lib/platform.ts`.
- **P0:** V4.1-V4.2 (web).
- **Acceptance:** the driving rows of V4.6 (web). The bridge rows are V0's.

### WP-V4: share (~2.5 days)

- **Owns:** relay `core/share.ts` and the `share_tokens` migration, the routes; bridge `src/share/**`, `share revoke`,
  `share shortcut` (P1); web `features/share/**`, `manifest.webmanifest`, `sw.ts` share handler; `docs/SHARE.md`.
- **P0:** V4.3-V4.5 without the `.shortcut` export.
- **Acceptance:** the share rows of V4.6.

### WP-V5: memory browser (~3 days)

- **Owns:** bridge `src/memory/**`, `memory init|on|off|show|reindex`; web `features/memory/**`; `captured/memory/`;
  `docs/MEMORY.md`.
- **P0:** V5 without the offline cache.
- **P1:** the offline cache.
- **Acceptance:** V5.4.

### WP-V6: e2e, docs, smoke (architect, after V1-V5)

**Owns:** `e2e/tests/{health,search,drive,share,memory}.spec.ts`, `docs/SECURITY.md` (V7), `scripts/smoke/v2.md`.

**e2e** (real relay, web and bridge):
- **Health:**
  - bridge stopped → `session_stopped` → restarted → `mac_back`;
  - the workflow script passes with the bridge stopped.
- **Search:** find a message → context view → Newer reaches latest.
- **Share:**
  - a token `curl` share → Inbox, `external`;
  - the `/share` page → `owner` with the content wrapped.
- **Memory:** a fixture dir → browse a chunked note → Ask carries `memory_path`.

---

## V9. SMOKE list

| Id   | Check                                                                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V9.1 | ntfy push on a locked iPhone; `mod_quiet` web push with a desktop tab visible; quiet-window hold of `session_stopped`                                                                                                                                    |
| V9.2 | `examples/health.yml` in a private repo: masked secrets, failure email on a stopped relay, no email with the Mac asleep overnight                                                                                                                        |
| V9.3 | `/drive` on an installed iPhone app (iOS 26/27): the unlocked element plays a voice follow-up 5 min after the toggle; a push tap as activation; Wake Lock; lock-screen controls; audio when another app comes to the front; the `play-and-record` switch |
| V9.4 | `speechSynthesis` fallback in a Home Screen app                                                                                                                                                                                                          |
| V9.5 | The Shortcut recipe with text, a Safari page and a photo; the photo-only path; `shortcuts sign --mode anyone` import from a Talos attachment                                                                                                             |
| V9.6 | `share_target` on Android Chrome; whether Chrome on macOS and Windows lists Talos                                                                                                                                                                        |
| V9.7 | `$.clock.every` during a long busy turn (the `mod_quiet` false-positive risk)                                                                                                                                                                            |
| V9.8 | Recursive `fs.watch` on a real agent folder in a synced location                                                                                                                                                                                         |

---

## V10. Owner questions (unanswered; the recommendations below are the defaults builders implement)

1. **Search depth.** The Mac keeps 90 days of history, so search covers 90 days. **Default:** 90 days public, and
   `TALOS_APP_HISTORY_DAYS=0` (text forever, media still pruned) for your Mac.
2. **Where the hourly check runs.** **Default:** a small private repo holding `examples/health.yml`. It avoids the
   60-day disable and public run history, at about 744 of the free 2,000 minutes a month.
3. **Shortcut shares as instructions.** They arrive as untrusted Inbox data. The bridge files them with no tap; the agent
   summarises and drafts freely, and anything with side effects is a card, so "do X" from the iPhone share sheet costs
   one tap. Instructions that act
   without a tap come only from the signed in-app `/share` page or a normal message. **Default:** keep it that way. A
   per-token "trusted" switch would reopen the leaked-token hole.

---

## Sources (fetched 2026-10-29)

- MDN browser-compat-data `manifests/webapp/share_target.json` (GitHub API): chrome 89, chrome_android 76, safari
  `false` (`impl_url` webkit.org/b/194593), safari_ios mirror, firefox false.
- WebKit [194593](https://bugs.webkit.org/show_bug.cgi?id=194593), "Add support for Web Share Target API": NEW,
  unassigned, last change 2026-05-23.
- [firt.dev iOS PWA compatibility](https://firt.dev/notes/pwa-ios/), updated 2026-10-13: `share_target` ❌; Screen Wake
  Lock "16.4 (18.4 for installed PWAs)".
- [Chrome: Web Share Target](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target): the app must be
  installed; files need POST + multipart.
- [GitHub Docs, `schedule`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows):
  5-minute minimum, delays and drops under load, 60-day disable in public repos, notifications to the cron's last
  editor.
- WebKit [291892](https://bugs.webkit.org/show_bug.cgi?id=291892), "WebAudio AudioContext silent after PWA returns from
  background, even after resuming it" (NEW). [237878](https://bugs.webkit.org/show_bug.cgi?id=237878), "AudioContext is
  suspended on iOS when page is backgrounded" (RESOLVED FIXED).
- Local runs:
  - the `bun:sqlite` FTS5 run (system SQLite 3.51.0 on macOS 26.7.1);
  - `shortcuts sign --help`;
  - talos-app at `0e6755a`: `history-store.ts` (four write methods, 90-day retention), `inbound.ts` (`schedQueue`, the
    frame-cap loop), `errors.ts` (`MAX_FRAME_BYTES`), `config-file.ts:104` (`config_conflict`), `useKeyboard.ts`
    (`Cmd+Shift+K`), `core/push.ts`, `core/hub.ts`.
- Adversarial design review (2026-10-29).
