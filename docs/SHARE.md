# Share to Talos

Send a link, some text, a page or a photo to your agent from any app. It arrives in the thread you pick (or in Inbox,
from an iPhone Shortcut), and your agent reads it as something to look at, never as an instruction.

Design: [V2-FEATURES.md](V2-FEATURES.md) V4.3 to V4.7.

## How each device shares

| Device                                       | How                                                   | What you get                                                                                               |
| -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Android (Chrome 76+), Chrome/Edge on desktop | Install Talos, then pick **Talos** in the share sheet | The `/share` page opens with the shared item in a box. Type what Talos should do, pick a thread, tap Send. |
| iPhone and iPad                              | An iOS Shortcut (below)                               | The item lands in **Inbox**.                                                                               |
| Any browser                                  | The bookmarklet (below)                               | The `/share` page opens with the page's title and link.                                                    |

**Why a Shortcut on iPhone:** iOS does not support the Web Share Target API, as of October 2026 (MDN has Safari and
Safari on iOS as unsupported; WebKit bug 194593 is open). A web app on the home screen cannot appear in the share
sheet, so an iOS Shortcut posts to your relay instead.

## iPhone: build the Shortcut

1. In Talos, open **Settings, Share from other apps**, type a name ("My iPhone"), choose whether to **Allow photos and
   files** (off by default), and tap **Create a share link**.
2. **Copy the secret now.** It is shown once. Only a hash is kept on the relay.
3. In the Shortcuts app, make a new shortcut and turn on **Show in Share Sheet**. Add these actions:
   1. **Receive** Text, URLs, Safari web pages (and Images and Files, if you allowed them) **from** Share Sheet.
   2. (optional) **Ask for Input**: "Note for Talos".
   3. **Get Contents of URL**: `https://<your relay>/api/share`.
      - Method: **POST**
      - Header `Authorization` = `Bearer <your secret>`
      - Request Body: **Form**, with these fields:

   ```shortcut-form
   text = Shortcut Input (as text)
   file = Shortcut Input
   note = Provided Input
   ```

   4. **Show Notification**: "Sent to Talos".

Leave out the `file` field if you did not allow files.

The same call works from `curl`:

```sh
curl -X POST https://<your relay>/api/share \
  -H "Authorization: Bearer talos_share_..." \
  -F "text=Read this later" -F "note=Summarise it"
```

It also accepts JSON (`Content-Type: application/json`) with the fields `text`, `url`, `title` and `note`. Anything else,
a thread name included, is refused with 400: a share link cannot choose where its item goes.

### From your Mac: `talos-app share shortcut`

```sh
talos-app share shortcut --label "My iPhone"      # add --files to allow photos and files
```

This makes a fresh share link for your newest enrolled device (`--device <id>` picks another), and writes the Shortcut to
`$TALOS_APP_HOME/shortcuts/`. On macOS it signs the file with `shortcuts sign --mode anyone` (needs macOS 12+ and an
iCloud sign-in), so you can AirDrop the `.shortcut` to your iPhone and tap **Add Shortcut**. Anywhere else, or if signing
fails, it leaves an unsigned `*.unsigned.shortcut` and prints the exact `shortcuts sign` command to run on a Mac, plus
the by-hand steps above. A Shortcut made this way is the same untrusted Inbox data as one you build by hand: there is no
"trusted" option.

**The file contains the key.** Forwarding it forwards the key. Revoke it from Settings, or:

```sh
talos-app share revoke sh_...        # the id is printed when the link is made; revoking twice is fine
```

## Android and desktop Chrome

Install Talos (Add to Home Screen, or Install in the address bar). The manifest declares a `share_target`, so Talos
appears in the share sheet. The service worker keeps the shared text, link and files on your device for up to 24 hours
and opens the `/share` page. Nothing goes to the relay until you tap Send, and then it is signed by your device like any
other message.

If the share does not reach the service worker (first run, a hard reload), the page says so and you can share again.

## Bookmarklet

Save this as a bookmark (the full line is under Settings, Share from other apps):

```
javascript:location='https://<your relay>/share?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)
```

Tapping it opens the `/share` page with the page's link and title filled in.

## What your agent sees

Shared material is always untrusted data. It is wrapped as external content, on every path.

| Path            | Who wrote the note                                            | Trust                                                                                                                                                                |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone Shortcut | A Shortcut cannot sign, so the note is not owner words either | `external`: the note and the content are both inside one wrapper. The agent may summarise, triage and propose a card. Anything with side effects waits for your tap. |
| `/share` page   | A note you type in the app is your words                      | The note is yours. The shared title, text and link are in a separate wrapper and are data.                                                                           |

The shared words never become your message text, so a page that says "ignore your instructions" cannot pass as you.

The Mac files each Shortcut share into a day file under `$TALOS_APP_HOME/shared-inbox/`, so "save this" needs no tap
and no agent judgment.

## Limits

| Thing                              | Limit                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Share links                        | 10 active                                                                              |
| Requests                           | 10 per minute per address (checked before the link is looked up), 30 per hour per link |
| Files (links with files allowed)   | 4 files, 20 MB each                                                                    |
| Text                               | 32,000 characters; note 4,000                                                          |
| Waiting files on the `/share` page | 24 hours                                                                               |

## Security

- A share link can call **one route** and put **one kind of row** in Inbox. It cannot read anything, fetch anything,
  write memory or run tools.
- The secret is hashed at rest, shown once, and tied to the device that made it. If that device is revoked, its links
  stop working.
- Settings lists each link with when it was last used and from which network (the first three parts of an IPv4 address,
  or the first three groups of an IPv6 one). Use from a network you do not know shows up there.
- **The URL alone gives away only the relay's host.** The secret travels in the `Authorization` header.
- **The Shortcut file contains the key.** If you export or forward the Shortcut, you forward the key. Revoke the link in
  Settings if it leaks. A leaked link lets someone drop untrusted rows into your Inbox, and that is all; nothing
  happens without your tap.
- A relay owner can turn the feature off with `SHARE_ENABLED=0`: every `/api/share` route then answers 404.

## Revoking

Settings, Share from other apps, **Revoke** next to the link, or `talos-app share revoke <id>` on the Mac. The next post
with that secret gets 401.

## Troubleshooting

| You see                                      | Why                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Shortcut says 401                            | The secret is wrong, the link was revoked, or its device was revoked. Make a new link. |
| 403                                          | The link was made without **Allow photos and files**, but the Shortcut sent a file.    |
| 400                                          | An empty share, a field the relay does not know, or text over the limit.               |
| 429                                          | Too many shares (see Limits). Wait a minute, or an hour.                               |
| Android: "That share didn't make it through" | The service worker was not ready. Share again.                                         |
