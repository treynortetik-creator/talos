---

title: Org-bound artifacts (Talos Pages)
date: 2026-11-11
status: spec for decision; nothing built
---

# Org-bound artifacts: build spec

_"est." = my estimate. "Inference" = not checked against code or a primary source. Talos paths are from `~/Documents/talos-app`. Roadmap entry: `ROADMAP.md`, "Org-bound artifacts" (owner's call 2026-11-10) and the order agreed 2026-11-11._

## 1. The answer in 6 lines

- **A "page" is an agent-made HTML file, stored on the org's relay, opened only by people the owner named, after they sign in with the org's own login.**
- **Most of the hard part exists.** Talos already serves agent HTML in a locked sandbox with no network and no access to the app. What's new: a store that outlives the 7-day buffer, a second kind of user (a viewer), and sharing.
- **Viewers sign in through the org's identity provider (OIDC).** Passkeys and device keys stay as they are, for the owner only.
- **No secret links.** A page URL is only an address. Every open checks the viewer's sign-in and the share list, so revoke is instant.
- **No PHI unless the relay is marked BAA-covered.** Off by default; warned at publish and at share, with a banner on every page.
- **Size: about 9-13 builder days plus review (est.), in 4 phases.** Phases 1-2 need nothing from anyone else. Phase 3 needs an OAuth client from the org.

**Premise to check first:** the roadmap says Anthropic's Artifacts don't work on BAA accounts. The owner's notes record Artifacts as covered on HIPAA-ready Enterprise per the 5/6/26 guide, and Cowork and Design as not covered. These may be two different things (in-chat artifacts vs. hosted, shareable pages). I did not resolve it. It doesn't change the build, but it changes how the GRC brief is worded.

## 2. Stack research: what professionals pick

| Question                              | Common practice (2026)                                                                                                                                                                                         | Pick for Talos                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Who signs in**                      | Central sign-in (SSO over OIDC) through the org's identity provider, usually behind an identity-aware proxy. Passkeys live inside the identity provider as the phishing-resistant factor, not beside it [3][4] | OIDC for viewers. Passkey plus device key stay for the owner. This is already planned as EP1, "OIDC beside passkey" (`ORG-READY-PLAN.md` wave table, row 5) |
| **Signed URLs vs. a checked request** | A presigned URL is a bearer credential: whoever holds it gets in, there's no per-link revoke, and no record of who opened it. A proxy checks every request [5][6]                                              | The relay serves every page itself and checks access each time. No presigned or "anyone with the link" URLs                                                 |
| **Agent-made HTML**                   | Three layers: a separate origin for untrusted content, a sandboxed iframe without `allow-same-origin`, and a strict CSP sent as a header. Claude's own Artifacts use this shape [1][2][7][8]                   | Reuse the existing sandbox and CSP. Add an optional second hostname in phase 4                                                                              |
| **Storage**                           | Small scale: encrypted files on the server's disk. Larger or regulated: a private bucket with the server in front                                                                                              | Relay volume now, behind a small store interface. A bucket adapter when it moves to org AWS                                                                 |
| **Versioning**                        | Immutable versions, one "current" pointer                                                                                                                                                                      | Same. Keep the last 10                                                                                                                                      |
| **Comments**                          | Kept outside the untrusted frame, in the trusted shell                                                                                                                                                         | Same, phase 5                                                                                                                                               |
| **Sharing**                           | Named people or groups from the directory. Public links off by default                                                                                                                                         | Named org emails only in v1                                                                                                                                 |

Railway signs a BAA only on its Enterprise plan [9]. A community answer puts it at $1,000 a month for 12 months [10] (unverified). So a personal Railway relay is not BAA-covered.

## 3. What Talos already has

| Piece                                                                                                                                                 | Where                                                                                                      | Reuse                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| HTML page route with a sandbox policy: script allowed, **no network at all**, opaque origin, no cookies                                               | `apps/relay/src/core/index.ts` (`PAGE_CSP`, `GET /media/:id/page`)                                         | Serve pages with the same policy, plus the permissions and referrer headers the app route sends           |
| The one iframe component. `sandbox="allow-scripts"` is fixed; a lint test fails on `allow-same-origin`                                                | `apps/web/src/ui/SandboxedFrame.tsx`, `apps/web/test/apps/sandbox-lint.test.ts`                            | The page viewer                                                                                           |
| Keyboard-grab guard on Chromium (no Run tap)                                                                                                          | `apps/web/src/ui/frameFocusGuard.ts`, `engine.ts`; `docs/SECURITY.md` "Side channels"                      | Same guards in the viewer                                                                                 |
| Markdown rendering with no raw HTML, then DOMPurify                                                                                                   | `apps/web/src/lib/markdown.ts`, `features/threads/MarkdownFileCard.tsx`                                    | Markdown pages (later)                                                                                    |
| Media store: encrypted on the volume, type sniffed from bytes. 50 MB a file, 200 MB a day, **7-day buffer**, then evicted and re-fetched from the Mac | `apps/relay/src/core/media.ts`, `sniff.ts`, `env.ts` (`MEDIA_MAX_MB`, `MEDIA_DAILY_MAX_MB`, `BUFFER_DAYS`) | Encryption and sniffing. Not the retention: a coworker's page can't depend on the owner's Mac being awake |
| Bug-report store: own folder, own table, total cap, 90-day sweeper, signed by the device key                                                          | `apps/relay/src/core/bug-reports.ts`, `packages/protocol/src/bug-report.ts`                                | **The template for the page store**                                                                       |
| Passkeys, sessions, CSRF, step-up, pairing gate, a pluggable auth seam                                                                                | `apps/relay/src/auth/`, `docs/SECURITY.md` "Relay authentication, as built"                                | Owner side unchanged. The viewer session is a second, narrower session type                               |
| Default-deny route table                                                                                                                              | `apps/relay/src/route-table.ts`, `packages/protocol/src/http.ts`                                           | Every new route listed with its login rule                                                                |
| Share links: hashed secret, one route, cap of 10, revoke                                                                                              | `docs/SHARE.md`, `apps/relay/src/core/share.ts`                                                            | The pattern for "can do one thing only". These are inbound, not page sharing                              |
| Settings table: every setting has a risk and a "Mac only" flag                                                                                        | `packages/protocol/src/settings-table.ts`, `config.ts`, `docs/CUSTOMIZE.md`                                | New settings rows (section 6)                                                                             |
| App CSP `frame-src 'self'`, which keeps a frame that navigates itself on the relay                                                                    | `packages/protocol/src/csp.ts`, `docs/SECURITY.md` line 510                                                | The viewer shell gets the same rule                                                                       |

**Gap that drives the design:** a relay has one owner and one Mac (`docs/ARCHITECTURE.md`, `WORK-MAC-PILOT.md`). A coworker has no way in today.

## 4. Goals and non-goals

**Goals**
- The agent publishes an HTML page: report, dashboard, explainer, or an interactive page with its data baked in.
- The owner shares it with named coworkers. They open it in any browser after org sign-in. No Talos install.
- Revoke, expiry and unpublish take effect on the next request.
- A page can't reach Talos, the viewer's session, or the internet.
- Pages live only on the relay the org runs.

**Non-goals (v1)**
- Public or "anyone with the link" pages.
- Pages that fetch live data or call tools. That's MCP Apps (`docs/APPS.md`).
- Pages that remember things per viewer. An opaque origin has no storage.
- Editing in place, an org-wide gallery, comments (phase 5).
- Many owners on one relay. That's EP2 in the org plan.
- Sending the coworker an email. The owner pastes the link.

## 5. User stories

| #   | Story               | What happens                                                                                                                                                                                                   |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Agent publishes** | The agent calls `publish_page` with a file, title and thread. The Mac scans it (section 7), uploads it signed, and the thread gets a page card. Private to the owner. No approval card: nobody else can see it |
| 2   | **Agent updates**   | Same call with the page id. A new version; the link stays the same                                                                                                                                             |
| 3   | **Owner shares**    | Owner taps Share, types coworker emails, picks an expiry, ticks "no PHI", taps Share. Signed by the device key. The agent may _propose_ a share as a card. It can never share by itself                        |
| 4   | **Coworker opens**  | Link, then org sign-in, then the page inside a Talos frame with title, owner, date and the banner. Not on the list: same "not found" screen as a page that doesn't exist                                       |
| 5   | **Revoke**          | Owner removes one person or taps Unshare all. The next request fails. An open tab keeps what it already loaded until it reloads (no cache is kept)                                                             |
| 6   | **Expiry**          | At expiry the share ends and the owner gets a row. The page stays private to the owner until deleted or 90 days unopened (est. default)                                                                        |
| 7   | **Roll back**       | Owner picks an older version as current                                                                                                                                                                        |
| 8   | **Audit**           | Owner sees who opened which version and when                                                                                                                                                                   |

## 6. Architecture

**Where pages live**
- Relay, new module `core/pages.ts`, copied from the bug-report store. Encrypted files under `/data/pages/`.
- Tables: `core_pages` (id, title, thread, owner device, current version, timestamps), `core_page_versions` (hash, bytes), `core_page_shares` (email, expiry, revoked), `core_page_views`.
- The Mac keeps the source file. The relay copy is what viewers get.
- Caps (est.): 5 MiB a version, 10 versions a page, 500 MiB in total (refuse with 507 past it, like bug reports), 200 pages.

**Routes** (all in the route table)

| Route                                                                           | Who                                             | Does                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /bridge/pages`                                                            | Mac, signed                                     | Create or add a version                                                            |
| `GET /api/pages`, `POST /api/pages/:id/share`, `/unshare`, `/current`, `DELETE` | Owner session; changes signed by the device key | Manage                                                                             |
| `GET /p/:id`                                                                    | Owner or viewer session                         | The shell: a small trusted page with the app CSP, holding the banner and the frame |
| `GET /p/:id/frame`                                                              | Owner or viewer session, share checked          | The page bytes, with the sandbox policy                                            |
| `GET /auth/org/login`, `/callback`, `/logout`                                   | Anyone                                          | OIDC code flow with PKCE                                                           |

**Access model**
- **Owner:** unchanged.
- **Viewer:** a new session type. Cookie `__Host-talos_v`, 8 hours, holding the verified email. It can reach `/p/*` and nothing else; `/api`, `/ws` and `/media` refuse it.
- **Sign-in rules:** email must be verified, the domain must be on the allowed list, and the org claim must match (for Google Workspace, `hd`).
- **Every request** to `/p/:id/frame` re-checks: session live, email on the share list, not expired, not revoked. `Cache-Control: private, no-store`.
- **Identity provider:** probably Google Workspace (Inference, from the Nyx code noted in `ORG-READY-PLAN.md` P6). Built as generic OIDC so Okta or Entra is a config change.

**The sandbox**
- Frame: `sandbox="allow-scripts"`, no `allow`, no referrer.
- Header: the existing page policy. Inline script and style only; images, media and fonts as `data:` or `blob:`; **no `connect-src`**, so no fetch, XHR or WebSocket. No forms, popups, downloads or top navigation.
- Result: opaque origin. The page can't read the Talos cookie, storage, API or the shell around it.
- **Consequence for the agent:** everything is inlined. No CDN scripts, no web fonts, no remote images. The Mac checks this before upload and tells the agent what to fix.
- **Known leftovers** (already in `docs/SECURITY.md`): WebRTC and DNS prefetch may leak what the page itself holds (Inference there); a page can try to grab the keyboard (guards exist). The bound that holds: **a page only knows its own contents.**
- **Phase 4 hardening:** serve frames from a second hostname with a 60-second, single-use ticket in place of the cookie [1]. It must be an added host. Changing the relay's main domain voids every passkey (`docs/decisions/0001-domain-and-rp-id.md`).

**Versioning**
- Versions are immutable and named by SHA-256. A re-upload of the same bytes is a no-op.
- The link always shows the current version. The owner can view and restore old ones. Viewers see current only.

## 7. Security model

| Threat                                                      | Answer                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger has the link                                     | Sign-in, then the share list. Missing and forbidden look the same                                                                                              |
| A coworker who was removed                                  | Checked on every request. 8-hour viewer sessions. Revoke deletes the share row                                                                                 |
| A hostile page (the agent was tricked by something it read) | Sandbox, no network, opaque origin. The viewer shell holds no owner data                                                                                       |
| The agent widens the audience                               | Share and unshare need a device-signed owner frame. The agent has no tool for it, only a proposal card                                                         |
| The agent edits a page after sharing                        | Allowed; that's the point. The owner gets a row per new version of a shared page. Optional setting: updates to shared pages need a tap                         |
| A login trick (wrong tenant, unverified email)              | Domain list, org claim, `email_verified`, state and PKCE, exact redirect URI                                                                                   |
| A taken-over relay                                          | It can read and change pages. Already true for threads (`docs/SECURITY.md` "What this does not protect against"). Encryption at rest covers a stolen disk only |
| A flood                                                     | Buckets per address and per viewer; the total cap                                                                                                              |

### The PHI rule

**A page must never carry PHI unless the relay it sits on is BAA-covered.** A page is a snapshot that sits on the host for weeks and is opened by other people. That's a bigger exposure than a 7-day thread.

| Layer                 | What                                                                                                                                                                                                          | Strength                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Setting**           | `org_pages.baa_covered`, default off, **Mac only** (the agent can't propose it, the phone can't flip it). Turned on only when the org confirms the relay's host is under its BAA                              | Hard                                                                                                      |
| **Agent rule**        | The `publish_page` tool text: no PHI, no resident names, use counts and de-identified examples                                                                                                                | Soft                                                                                                      |
| **Scan on the Mac**   | Before upload: pattern checks (MRN, SSN, date of birth, phone, email, addresses). Hits are listed on the page card and block **sharing**, not private publish, until the owner taps "I checked, share anyway" | A fence. The Nyx gate caught 40.3% of formatted cases and 0 of 105 written-out ones (`ORG-READY-PLAN.md`) |
| **Owner attestation** | A required "This page has no PHI" tick on every share while the setting is off. Logged with time and device                                                                                                   | Accountability                                                                                            |
| **Banner**            | Viewer shell, outside the frame: "Internal to <org>. Not for PHI." When the setting is on: "Internal to <org>."                                                                                               | Reminder                                                                                                  |
| **Sharing switch**    | `org_pages.sharing`, default off, Mac only. The owner turns it on per relay                                                                                                                                   | Hard                                                                                                      |

This follows his ruling that the PHI gate stays light (`ROADMAP.md` line 83) and adds the two hard switches. Stated plainly: **nothing here can prove a page is PHI-free.** The controls are the switches, the owner's tick and the audit trail.

**Settings rows to add** (`settings-table.ts`): `org_pages.sharing` (mac), `org_pages.baa_covered` (mac), `org_pages.allowed_domains` (mac), `org_pages.default_expiry_days` (low), `org_pages.updates_need_tap` (low). The OIDC client id and secret are relay variables in `env.ts`, never config.

## 8. Phased build plan

A Claude Design canvas mock comes first (publish card, Pages list, share sheet, coworker view). One `talos-builder` per phase; Opus review before main on phases 2 and 3.

| Phase                                 | Scope                                                                                                                                             | Size (est.)                     | Tests                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Store and publish (owner only)** | Protocol `org-pages.ts`; relay `core/pages.ts` and routes; bridge `publish_page`; page card; Pages screen; versions and restore; caps and sweeper | 3-4 days                        | Signed upload accepted, unsigned refused; same bytes twice is one version; 11th version drops the oldest; 507 past the cap; frame response carries the exact sandbox policy; a page that tries `fetch`, a form, a popup and top navigation fails each (Playwright, Chromium and WebKit); route-table test; sandbox lint still passes                                                                                                |
| **2. PHI fence and settings**         | Settings rows; Mac scan and the inline-only check; attestation; banner; agent tool text                                                           | 1-2 days                        | A fixture with planted identifiers is flagged; a clean one passes; the agent can't propose the Mac-only rows; the phone can't flip them; the banner follows `baa_covered`                                                                                                                                                                                                                                                           |
| **3. Viewer sign-in and sharing**     | Generic OIDC; viewer session; share sheet; `/p/:id` shell; revoke; expiry; view log. **Security-critical**                                        | 4-5 days                        | Fake identity provider in testkit: wrong domain, unverified email, bad state and a replayed code are all refused; a viewer cookie gets 401 or 403 on every `/api`, `/ws` and `/media` route (walk the whole table); not shared and missing return identical bytes; revoke fails the next request; expiry by fake clock; the agent has no share tool; share without the tick is refused; e2e from publish to coworker open to revoke |
| **4. Org infrastructure**             | Second hostname with tickets; store adapter for a bucket; deploy notes for org AWS; `baa_covered` runbook                                         | 2-3 days, plus the org's DevOps | Ticket is single use, expires in 60 s, bound to page, version and viewer; adapter contract suite on disk and a fake bucket                                                                                                                                                                                                                                                                                                          |
| **5. Later**                          | Comments in the shell; "Shared with me" list; Markdown pages; share to a directory group                                                          | not sized                       | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Ship rule:** phases 1-2 can go live on any relay. Phase 3 stays behind `org_pages.sharing` until the open questions are answered.

## 9. Open questions for the owner

| #   | Question                                                                                                                                                                               | Recommended answer                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Which relay gets coworker sharing first?** Sharing from your personal Railway puts company pages on hosting the company doesn't control, which is the opposite of "inside the walls" | Build and test on the personal relay with yourself as the only viewer. Turn sharing on only on the work Mac's relay, no-PHI rule on, and move to org AWS in phase 4   |
| 2   | **Which login do coworkers use?**                                                                                                                                                      | Google Workspace over OIDC, gated to the company domain (Inference that it's the identity provider). Needs EIT to create one OAuth client. Ask while phases 1-2 build |
| 3   | **PHI: warn or block?**                                                                                                                                                                | Warn plus a required tick, and scan hits block sharing until you override. Hard switch stays off until the host is under the BAA. Matches your "light gate" ruling    |
| 4   | **Who can a page be shared with?**                                                                                                                                                     | Named coworkers only in v1. "Everyone at the company" and groups wait for phase 5 and a GRC view                                                                      |
| 5   | **Default expiry?**                                                                                                                                                                    | 30 days, with 7, 90 and "until I unshare" as choices. The agent can suggest one but can't lengthen it                                                                 |
| 6   | **Does coworker sharing need a GRC brief first?** I don't know who decides this                                                                                                        | Assume yes, and ask. A short brief is cheap, and phase 3 is the first time Talos shows anything to a second person at work                                            |

## Sources

Web (searched 2026-11-11):
1. [web.dev, "Securely hosting user data in modern web applications"](https://web.dev/articles/securely-hosting-user-data): sandbox domains, and why cookies don't carry over to them
2. [Google Security Blog, same title, April 2023](https://security.googleblog.com/2023/04/securely-hosting-user-data-in-modern.html)
3. [youngju.dev, "Zero trust identity-aware proxy", June 2026](https://www.youngju.dev/blog/devops/2026-06-12-zero-trust-identity-aware-proxy.en): vendor-neutral blog, directional
4. [PropelAuth, "Internal tools auth"](https://byo.propelauth.com/post/internal-tools-auth): vendor blog, directional
5. [Georg Schwarz, "Serving private S3 objects: backend proxy vs gateway auth vs presigned URLs"](https://georg-schwarz-com.pages.dev/blog/serving-private-s3-objects-backend-proxy-gateway-auth-presigned-urls)
6. [Advanced Web Machinery, "Are S3 signed URLs secure?"](https://advancedweb.hu/are-s3-signed-urls-secure/)
7. [Simon Willison, "Can JavaScript escape a CSP meta tag inside an iframe?", April 2026](https://simonwillison.net/2026/Apr/3/test-csp-iframe-escape/)
8. [Simon Willison on how Anthropic built Artifacts, August 2024](https://feeds.simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts/); [HackerNoon, "Three security boundaries for hosting untrusted AI-generated HTML"](https://hackernoon.com/three-security-boundaries-for-hosting-untrusted-ai-generated-html) (secondary)
9. [Railway changelog, "HIPAA BAAs", July 2024](https://railway.com/changelog/2024-07-12-hipaa-baas)
10. [Railway Help Station, HIPAA question](https://station.railway.com/questions/hipaa-b7b69933): community answer, unverified

I read search summaries of these, not every page in full. No OWASP page on capability URLs turned up. No web research was done on the org.

Local: the Talos files in section 3; `ROADMAP.md`; `WORK-MAC-PILOT.md`; `PEER-LINKS-SPEC.md`; the owner's org-readiness plan and BAA feature notes (private).

## Owner decisions (2026-11-11 14:52-14:54 MST; these override the spec above where they differ)

1. Build and test on the owner's personal relay (not BAA-covered; no real PHI there); a work-hosted relay later.
2. Coworker login: Google sign-in (OAuth/OIDC) with two-factor, or riding the Claude login if that proves possible. Investigate the Claude option; default to Google OIDC.
3. PHI: do NOT block or scan. the org is on a BAA enterprise agreement and some people legitimately work with PHI. No PHI scan, no required tick, no BAA switch; at most a quiet notice in docs. (Drop the spec's PHI gating.)
4. Sharing: "everyone at the company" is allowed in v1 (all behind the org login; never public). Named people too.
5. Expiry: 30 days by default; the sharer can extend it (a setting or tick). Throwaway is the norm.
6. No feature-specific GRC brief: the whole Talos app goes through one GRC review document.
   Premise clarified (owner): in-chat Anthropic artifacts are BAA-covered; the PUBLISHED/shared artifact website is what falls outside the BAA. Org-bound artifacts are the BAA-safe way to share a page.
   Next: a Claude Design mock of publish/share/open, then build phase 1.
