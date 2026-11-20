# Voice input (archived 2026-11-19)

Talos used to take the owner's voice in three ways: dictation into the message box, the microphone for voice notes, and a
live call with the agent. The owner asked for all three to be removed and archived for now, in case they are wanted back. The code is **removed from main**, not hidden: nothing
reaches it and nothing in the build loads it. This page says what each part was, where it lives now, and how to bring it
back.

- **Archive tag:** `archive/voice-2026-11-19`, the commit `d92f4285` ("Sub-threads: a folder of its own under a parent with
  none"). Everything described here is in that tree.
- **What stays:** reading replies aloud (the bridge's TTS service, the Speak button, `reply` voice attachments), driving
  mode and the /drive screen as a listen-only screen, the agent's own `kit/scripts/stt.sh`, and the display of old voice
  notes, call records and transcripts already in a thread's history. See "What was kept" below.

## What each part was

### 1. Dictate

One tap on the composer's dictate button recorded, a second tap stopped, and the transcript was put into the message box
after whatever was there. Dictation never sent anything.

```
 composer ──POST /api/dictate (raw audio, session + CSRF)──▶ relay ──▶ OpenAI /v1/audio/transcriptions
    ◀── { text } ────────────────────────────────────────────────────────┘
```

- The audio passed through the relay to OpenAI and the relay kept none of it (memory only for the one request).
- Formats m4a, mp4, wav, webm and mp3, checked by claimed type and first bytes; 25 MB at most; model `TRANSCRIBE_MODEL`
  (default `gpt-transcribe`). Without `OPENAI_API_KEY` the route answered 503 `dictate_disabled` and `GET /api/me` said
  `dictate: { available: false }`.
- Limits: the `dictate` rate limit (40 an hour) and `DICTATE_DAILY_MAX_MB` (100) of audio per 24 hours, counted in the
  relay table `voice_dictation_usage`. `DICTATE_TIMEOUT_S` (90) bounded the wait for OpenAI.
- Errors the app told apart: `too_large` 413, `unsupported_type` 415, `rate_limited` and `daily_cap` 429,
  `upstream_refused` and `upstream_unreachable` 502, `upstream_timeout` 504, `dictate_disabled` 503.
- Recording stopped by itself at 10 minutes. When transcribing failed the recording stayed in memory with Try again, Send as
  voice note or Discard.

### 2. Voice-note microphone

The composer's mic button recorded a voice note (hold, or tap to lock) and sent it as a signed `voice_note` frame with the
audio as a media attachment. The bridge downloaded it, checked the signed hash, and ran the owner's own speech-to-text
command (`TALOS_APP_STT_CMD`), then handed the agent the transcript as the message (`kind=voice_note`, `trust=owner`, with
`audio_path`, `transcript_engine`, `duration_s`). The bridge sent a `transcript` frame (pending, then done or failed) so the
app could show the words under the bubble. Without a command the note arrived as "(voice note; no transcriber configured)".

- Kept recordings: a recording that could not be sent was held in a per-client store (`keptNotes.ts`) so leaving the thread
  or starting a call did not lose it; a banner in the note's own thread offered to send or delete it.
- Direct-send fallback with a deadline (`lib/uploadDeadline.ts`, `uploadVoiceWithDeadline`).
- The mic-off line ("Microphone is off for Talos") and the recorder's release of the mic on every exit path.
- The `reply_with_voice` choice "when I send a voice note" (`when_voice`) existed for this; see the decisions below.

### 3. Live call (the realtime agent chat)

A phone-call-style conversation: the browser carried audio to an OpenAI realtime model (GPT-Live); the model never had tools;
when the owner asked for something that needed their data it raised a delegation, the app wrote the question from its own
transcript and signed it (`voice.ask`), and the bridge gave it to the agent as `kind=voice_delegation`
`trust=owner_voice`. The agent answered with `reply` (a `speak` line for the voice, the full `text` for the thread) and
could report progress with the `voice_progress` tool (`voice.progress` frame). When the call ended the relay sent a
`voice.ended` record (the bridge wrapped it as `kind=voice_ended`, external) and stored a `call_record` message plus
`voice_turn` rows in the thread.

```
 browser ──WebRTC audio + data channel──▶ GPT-Live (OpenAI)
    │                                          ▲
    │ POST /api/voice/session {thread_id, sdp} │ sideband (wss, relay holds the API key)
    ▼                                          │
  relay  ───────────────────────────────────────┘
    │ signed voice.ask  ──▶ bridge ──▶ the agent
    ◀ reply / voice.progress ◀──
```

- Relay module `apps/relay/src/voice` (`index.ts` routes `POST /api/voice/session` and `/close` and the bus handlers;
  `manager.ts` session lifecycle, hand-offs, timers and caps; `gpt-live.ts` the OpenAI provider; `provider.ts`,
  `fake-provider.ts`, `session-config.ts`, `seed.ts`, `prompt.ts`, `ports.ts`, `status.ts`). Caps: `VOICE_DAILY_MAX_MIN`
  (60) and `VOICE_SESSION_MAX_MIN` (30), counted in `voice_usage`. Timers: 3 s for the app to sign a `voice.ask`, 20 s of
  agent silence before one "still on it" line.
- The relay refused a `voice.ask` for a call that was not live, a delegation the provider never created, another thread
  than the call's, or a second ask for the same delegation. The core never queued a `voice.ask` for the bridge unless the
  voice module had registered a handler.
- Settings: Live-call voice (`agent.voice`, the stock GPT-Live voices, default `meridian`), the live-call persona
  (`agent.voice_persona`, high risk), Hands-free versus Hold to talk (per device), and per thread "Live-call context"
  (`thread.voice_context`, whether a call may be seeded with the thread's recent messages).
- Web: `apps/web/src/features/voice/*` (`callController.ts`, `index.tsx` with `LiveCallButton`, `CallBar`, `CallScreen`,
  `VoiceSettingsSection`, `useIsOnCall()`), the call was foreground-only on iOS, ended on `visibilitychange` to hidden, and
  `endLiveCall` ran on sign-out.

### 4. /drive "Talk live"

The /drive screen had a Talk button (tap to talk, `loadTapToTalk` / `saveTapToTalk`), a "Talk live" and "End call" pill, and
the controller's `beginTalk` / `endTalk` / `finishTalk` with the same unsaved-recording and kept-note logic as the composer.
Drive also held its clips while a call was on, and `threads/speak.ts` did not read aloud during a call. /drive is now a
listen-only screen: queue, playback, the driving row, card announcements and `driving_until` are unchanged.

## What was kept

- Text to speech: `apps/bridge/src/speak/service.ts`, `apps/web/src/lib/socketSpeak.ts`, `threads/speak.ts`,
  `kit/scripts/voice/*_tts.py`, the drive queue and playback, `audioDock.ts`, the media session.
- Rendering of history: the message kinds `voice_note`, `call_record` and `voice_turn`, `MessageT.transcript` (old notes play
  with their transcripts), the attachment kind `voice_note` and the role `voice_reply`, and search in transcripts. The relay
  still stores, fans out and pages the `transcript` frame, and a relay history row written as a `voice_note` still renders.
  The bridge no longer sends `transcript`, so nothing writes a new one.
- `voice_notes.reply_with_voice` (`always` / `never`) and `voice_notes.driving_until`.
- `kit/scripts/stt.sh` and `kit/scripts/stt-diarize/`: the agent's own transcription tool, unrelated to the app.
- The Mac app's `device.audio-input` entitlement and its Info.plist microphone text: the agent's own microphone use.
- Push `kind: 'voice_result'` is still accepted in a push payload (the template that produced it, `answer_ready`, is gone).

## Decisions made when it was archived

a. `reply_with_voice` "when I send a voice note" (`when_voice`): dropped from the UI and from what the agent may set. A config
that still says `when_voice` reads as `never` (`wantVoiceReply` in `packages/protocol/src/driving.ts`). The schema still
accepts it. The default is now `never`. The agent's `reply` tool no longer has a `voice` argument; spoken replies follow
the setting (and driving mode), with `voice_text` as the spoken version.
b. Queued `voice_note` and `voice.ask` outbox entries on devices are dropped on load with one line, "An unsent voice note was
removed (voice notes are off)".
c. `kit/scripts/stt.sh` stays; only the bridge's automatic voice-note transcription went.
d. The Mac entitlement `device.audio-input` and its Info.plist text stay. Only the web page's microphone grant went (Swift,
done in the "Swift: the iOS and Mac web views never grant the page the microphone" commit, see "Swift pieces" below).
e. Config keys `thread.voice_context`, `agent.voice` and `agent.voice_persona`: the schema still **accepts** them in an old
`config.json` and ignores them (an unnamed key is dropped on read). They are gone from the settings table, the UI, the
example configs and the goldens.
f. Relay tables `voice_usage` and `voice_dictation_usage`: left in place. The migration files `apps/relay/migrations/voice/`
still run (`MODULE_ORDER` in `apps/relay/src/migrate.ts` still lists `voice`), so the tables exist on every relay and a
restored module finds them. Nothing reads or prunes them now; rows older than the keep window stay.

Also changed when it went:

- The relay's `Permissions-Policy` for every response is `microphone=()` (it was `microphone=(self)`).
- A relay response to `POST /api/dictate`, `/api/voice/session` or `/api/voice/session/:id/close` is now the unknown-route
  404; `GET /api/me` has no `voice` or `dictate` field; an app frame `voice_note`, `voice.ask`, `voice.state`,
  `voice.progress` or `voice.ended` is an unknown frame type (`bad_frame`); the bridge answers the same way and tells the
  owner once that a newer peer sent something it cannot read.
- The `health.beat` field `stt` (the bridge's own speech-to-text command) is no longer sent or read; `limits` in
  `GET /api/status` no longer has `voice_daily_max_min` and `voice_session_max_min`; `talos-app status` no longer prints
  STT. A relay older than this change refuses a beat without `stt`, so deploy the relay first.
- Channel kinds `voice_note`, `voice_delegation`, `voice_ended` and the trust `owner_voice` are gone from `ChannelMeta`; the
  agent instructions no longer mention calls, voice notes or dictation; the `speak` and `voice_delegation_id` fields of a
  `reply` and the `voice_progress` tool are gone.
- The native-shell message `voice_note` (reserved, never sent) is gone from `packages/protocol/src/native.ts` and the
  fixtures.
- The Playwright `chromium-media` project and the fake-microphone flags, `scripts/mic-preflight.{mjs,test.ts}` and its use
  in `scripts/ci-local/jobs-mod-browser.sh`, and the gate's special cases for the voice spec folders.
- The relay no longer depends on the `openai` npm package (it was used only by `gpt-live.ts`).

## External needs

Relay environment (all unset or ignored now; Railway variables were left alone):

| Variable                | Was for                                                 |
| ----------------------- | ------------------------------------------------------- |
| `OPENAI_API_KEY`        | live call and dictation; without it both answered "off" |
| `OPENAI_BASE_URL`       | where dictation went; tests pointed it at a fake server |
| `TRANSCRIBE_MODEL`      | the dictation model (default `gpt-transcribe`)          |
| `DICTATE_DAILY_MAX_MB`  | audio accepted in 24 hours (default 100)                |
| `DICTATE_TIMEOUT_S`     | the wait for OpenAI (default 90)                        |
| `VOICE_MODEL`           | the live-call model (default `gpt-live-1`)              |
| `VOICE_DAILY_MAX_MIN`   | live minutes a day (default 60)                         |
| `VOICE_SESSION_MAX_MIN` | minutes per call (default 30)                           |

Bridge environment: `TALOS_APP_STT_CMD` (JSON argv, `{in}` is the audio file, transcript on stdout), `TALOS_APP_STT_LONG_CMD`
(used above `TALOS_APP_STT_LONG_AFTER_S`, 30 s), `TALOS_APP_STT_TIMEOUT_S` (180).

Relay tables left in place: `voice_usage`, `voice_dictation_usage` (migrations `voice/0001_init.sql`,
`voice/0002_dictation_usage.sql`).

Permission strings: iOS `NSMicrophoneUsageDescription` (Info.plist / `project.yml`, removed); the Mac app's microphone grant
for the web page (removed). See "Swift pieces".

## Commits that introduced it

| Commit     | Date       | What                                                                                                         |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `a2f5804c` | 2026-10-28 | WP4: live voice (relay module, web call controller, settings)                                                |
| `0952a49a` | 2026-10-28 | WP5: bridge (voice-note transcription, `voice.ask` / `voice.ended` handling, `voice_progress`)               |
| `1cd1eff7` | 2026-10-28 | WP6: web shell and threads (the recorder and the composer mic)                                               |
| `2e1774a9` | 2026-10-30 | iOS WP-I0: Capacitor shell project (#51), the microphone permission and the audio session                    |
| `dbbd7c75` | 2026-10-30 | V2 WP-V3: driving mode (web) (#43), /drive and its Talk button                                               |
| `43ea27e8` | 2026-11-02 | One-touch dictation through the relay                                                                        |
| `21c4df0f` | 2026-11-03 | Mac app: the microphone works for the Talos page                                                             |
| `dc26442a` | 2026-11-03 | Mac app microphone: review fixes, the right hint, the security note (`micOff`)                               |
| `9953e711` | 2026-11-16 | Voice review 3: kept recordings in a per-client store, direct-send deadline, the banner in the note's thread |

`git show --stat <sha>` lists each commit's files. Later changes touched the same files; the tag has the final state.

## Files to restore

All paths are relative to the repository root and exist in the tag. Restore a feature by checking its paths out of the tag,
then putting the wiring back (below). `git checkout archive/voice-2026-11-19 -- <paths>`.

**Relay (all features)**

- Live call: `apps/relay/src/voice/` (all files), `apps/relay/test/voice/`, `apps/relay/test/review/voice-ack.test.ts`,
  `apps/relay/test/wp8/voice-turns.test.ts`.
- Dictate: `apps/relay/src/dictate/` (`index.ts`, `sniff.ts`, `status.ts`), `apps/relay/test/dictate/`.

**Bridge**

- Voice-note transcription: `apps/bridge/src/stt.ts`, `apps/bridge/test/fixtures/fake-stt.sh`, `slow-stt.sh`.
- Tests of notes, asks and ends: `apps/bridge/test/voice.test.ts`.

**Protocol and testkit**

- Fixtures: `packages/protocol/fixtures/frames/voice_note.json`, `voice.ask.json`, `voice.ended.json`, `voice.progress.json`,
  `voice.state.json`, and the `voice_note` entry of `packages/protocol/fixtures/native/messages.json`.
- Testkit helpers `FakeApp.sendVoiceNote` and `FakeApp.sendVoiceAsk` (`packages/testkit/src/fake-app.ts`) and the matching
  fake relay and fake bridge cases.

**Web** (check the paths out and re-add the wiring)

- Dictate: `apps/web/src/features/composer/useDictation.ts`, `useComposerDictate.tsx`, `DictateUi.tsx`, `dictate.ts`,
  `IconDictate` in `apps/web/src/ui/icons.tsx`; tests `dictate-button.test.tsx`, `dictate.spec.ts`, `dictation.test.tsx`,
  `text-changes-during-recording.test.tsx`; `e2e/tests/14-dictation.spec.ts`, `e2e/harness/stubs/stt.sh`.
- Voice-note mic: `composer/useComposerVoice.ts`, `RecorderLockedRow.tsx`, `keptNotes.ts`, `recorder.ts`,
  `lib/uploadDeadline.ts`, `lib/micOff.ts`; the `sendVoiceNote` / `queueVoiceNote` part of `lib/socket-client-send.ts`; the
  `voice_note` and `voice.ask` outbox kinds in `lib/socket-*.ts`; tests under `apps/web/test/composer/` and
  `apps/web/test/voice/voice-note.spec.ts`.
- Live call and Talk: `apps/web/src/features/voice/` (all), the call parts of `features/drive/controller.ts`,
  `drive/index.tsx`, `drive/prefs.ts`, `drive/instance.ts`; `apps/web/test/voice/`, `apps/web/test/voice-setup/`.
- Playwright: the `chromium-media` project and fake-microphone flags in `apps/web/playwright.config.ts` and
  `e2e/playwright.config.ts`, `scripts/mic-preflight.mjs` and `.test.ts`.

**Wiring to put back**

1. Protocol (`packages/protocol/src`): `VoiceNoteFrame`, `VoiceStateFrame`, `VoiceAskFrame`, `VoiceProgressFrame`,
   `VoiceEndedFrame` in `frames.ts` and every list that named them (`frameSchemas`, `OWNER_FRAME_TYPES`,
   `DURABLE_FRAME_TYPES`, `CONSUMABLE_FRAME_TYPES`, `DIRECTION_TYPES`); `ReplyFrame.speak` and `.voice_delegation_id`;
   `http.ts` (`me.voice`, `me.dictate`, the `dictate`, `voiceSession` and `voiceSessionClose` routes); `settings-table.ts`
   (`VOICE_CHOICES`, `agent.voice`, `agent.voice_persona`) and the matching optional keys in `config.ts` and `models.ts`;
   `channel-meta.ts` (the three kinds, `owner_voice`, the meta keys); `health.ts` (`stt`, the voice limits); `native.ts`
   (`NativeVoiceNote`); `push.ts` (`answer_ready`); `config.ts` default of `reply_with_voice` and the `when_voice` rule in
   `driving.ts`.
2. Relay: `modules.ts` (`voice.register`), `routes.ts` (both routers), `index.ts` (`shutdownVoice`), `env.ts` (the variables
   above), `auth/index.ts` (`voice` and `dictate` in `/api/me`), `auth/limits.ts` (`voice`, `dictate` buckets and `GLOBAL`),
   `auth/impl.ts` and `core/body-guard.ts` (the `/api/dictate` carve-outs), `core/health.ts` (the limits), `core/hub*.ts`
   (the `voice_note` and `voice.ask` app cases, `SHOWS_A_PERSON`, `Hub.recentMessages`), `core/hub-bridge-frames.ts`
   (`answer_ready`), `core/default-config.ts`, `core/index.ts` (`microphone=(self)`), `.env.example`, and `openai` in
   `apps/relay/package.json`.
3. Bridge: `config.ts` (the STT variables), `inbound-messages.ts` (`voiceNoteContent`, `onVoiceNote`, the backlog branch),
   `inbound-events.ts` (`onVoiceAsk`, `onVoiceEnded`), `inbound.ts` and `inbound-lanes.ts`, `notify.ts`
   (`voiceNoteNotification`, `voiceDelegationNotification`, `voiceEndedNotification`), `trust.ts` (`recordVoiceAsk`),
   `frames-out.ts` (`transcriptFrame`, `voiceProgressFrame`, the reply extras), `tools/misc.ts` and `tools/table.ts`
   (`voice_progress`), `tools/send.ts` (`speak`, `voice_delegation_id`, `voice`), `instructions.ts` (the live-call and voice
   note sentences), `peer/taint.ts`, `main-resend.ts`, `router/router.ts`, `undo/route-point.ts`, `tools/read-inbound.ts`,
   `health/monitor.ts` (`stt`), `cli-main.ts` (the STT line). Then update the instruction-hash test and the
   `agent-instructions` fixtures, the tool-table and settings goldens, and the replay goldens.
4. Docs: the sections marked archived in the original build spec, `docs/PROTOCOL.md`, `docs/bridge.md`, `docs/ios.md`,
   `docs/desktop.md`, `docs/iphone-checklist.md`, `docs/V2-FEATURES.md`, `docs/SECURITY.md` (the `owner_voice` trust) and
   `docs/SETUP.md`.

A faster way to see exactly what changed: `git diff archive/voice-2026-11-19 HEAD --stat`, then restore
file by file with `git checkout archive/voice-2026-11-19 -- <path>` or reverse-apply the archive commit's diff.

## Swift pieces to restore (done: removed in a separate Swift commit)

The Swift side was removed by the commit "Swift: the iOS and Mac web views never grant the page the microphone" (not part of the
archive commit, so the tag still has these pieces). These are the places to put back, from the tag or from that commit's parent:

- iOS: `NSMicrophoneUsageDescription` in `apps/mobile/ios` (`Info.plist` and `project.yml`); the media-capture grant in
  `WebViewGuards` (now always `.deny`); `TalosAudio` `playAndRecord` and `record` modes with `AudioSessionPolicy` `.record`; and
  `stopMediaCapture` and `mediaCaptureStops` in `TalosBridgeViewController`, with the matching `AppTests`.
- Mac: the `WebWindow` media-capture delegate (now always `.deny`), `WebPolicy.MediaKind` and `WebPolicy.grantsMedia` in
  `apps/desktop`. The entitlement
  `device.audio-input` and its Info.plist text stayed (decision d).
- The web side's `'play-and-record'` audio-session type in `lib/platform.ts` and `lib/capacitorPlatform.ts`.

## How to restore

1. Decide the scope (dictate, notes, call, Talk) and check the paths out of the tag with
   `git checkout archive/voice-2026-11-19 -- <paths>`.
2. Put the wiring back (the list above) and re-add the relay variables; set `OPENAI_API_KEY` for dictate and the live call,
   and `TALOS_APP_STT_CMD` for notes.
3. Regenerate what is generated: `pnpm --filter @talos-app/protocol gen:fixtures`, `node scripts/native-fixtures.ts`, and the
   goldens (`WRITE_GOLDEN=1` for the settings parity tests, `UPDATE_GOLDEN=1` for the replay tests), then the instruction-hash
   test and the `agent-instructions` fixtures.
4. Put `microphone=(self)` back in the relay's `Permissions-Policy`, the Playwright `chromium-media` project, and the Swift
   pieces above.
5. Run the relay, bridge, protocol and web suites, and the manual smoke lists for WP4, WP5 and WP6.

The history of the design is in the original build spec, sections 6, 8.3 and 8.6 (marked archived there), and in the audit
notes (left as written).
