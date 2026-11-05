# Live voice

How a phone call with the agent works, and where each piece lives. The authoritative text is the original build spec (not published), sections 6 and 8.6.

## The shape

```
 browser ──WebRTC audio + data channel──▶ GPT-Live (OpenAI)
    │                                          ▲
    │ POST /api/voice/session {thread_id, sdp} │ sideband (wss, relay holds the API key)
    ▼                                          │
  relay  ───────────────────────────────────────┘
    │ signed voice.ask  ──▶ bridge ──▶ the agent (slow, has the tools)
    ◀ reply / voice.progress ◀──
```

- The browser carries audio only. It may send three events and receive five (spec 6.2); everything else, including
  commentary, goes through the relay's sideband.
- `OPENAI_API_KEY` lives only in the relay environment. Without it the module registers nothing and
  `POST /api/voice/session` answers 503.
- The voice model never gets tools. When the owner asks for something that needs their data, it raises a delegation
  (`session.delegation.created`, no task text). The **app** writes the question from its own transcript and signs it
  (`voice.ask`), so what the agent receives is what the owner said, not what the model paraphrased. Side effects still
  go through a card.

## Relay (`apps/relay/src/voice`)

| File                | Role                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | The two routes, bus handlers (`voice.ask` from apps; `voice.progress` and `reply` from the bridge)                        |
| `manager.ts`        | Session lifecycle, hand-off, timers, caps, call records                                                                   |
| `provider.ts`       | `VoiceProvider` / `Sideband` interfaces                                                                                   |
| `gpt-live.ts`       | OpenAI GPT-Live provider (`live.create`, sideband websocket)                                                              |
| `fake-provider.ts`  | Scripted provider for tests                                                                                               |
| `session-config.ts` | The `session` object and the allowed data-channel events, checked against the installed `openai` types                    |
| `seed.ts`           | `InitialItem[]` for a new call                                                                                            |
| `prompt.ts`         | The frontend prompt                                                                                                       |
| `ports.ts`          | Adapters to message history (the core hub's `recentMessages`) and message storage (call records fan out to the apps only) |

Timers (all from `services.clock`): 3 s for the app to sign a `voice.ask` after a delegation appears, 20 s of silence
from the agent before one "still on it" line, session cap warning at cap minus one minute.

What the relay refuses: a `voice.ask` for a call that is not live, for a delegation the provider never created, for a
different thread than the call, or a second time for the same delegation.

Logs never contain transcript, question or answer text; sideband events are logged by `type` only.

## Web (`apps/web/src/features/voice`)

`callController.ts` runs one call (microphone, peer connection, data channel, hand-off, hold-to-talk, hang-up on
background). `index.tsx` has the components the shell mounts (`LiveCallButton`, `CallBar`, `CallScreen`,
`VoiceSettingsSection`) plus `useIsOnCall()` for swapping the composer for the call bar. The call is foreground-only on
iOS: `visibilitychange` to hidden or `pagehide` ends it, and work already handed off keeps running.

## Dictation (speak, get text in the box)

One tap on the dictate button in the composer starts recording, a second tap stops it, and the words appear in the message
box after whatever is there now (at the end, never over anything). The owner edits and taps Send; dictation never sends.

```
 composer ──POST /api/dictate (raw audio, session + CSRF)──▶ relay ──▶ OpenAI /v1/audio/transcriptions
    ◀── { text } ────────────────────────────────────────────────────────┘
```

- **Audio passes through the relay to OpenAI and the relay keeps none of it.** It is held in memory for the one request:
  never written to disk, the media store or the database. Logs carry byte counts and status codes only, never audio, words
  or the key (the same rule as live voice).
- Route, `apps/relay/src/dictate`. Formats m4a, mp4, wav, webm and mp3, checked by the claimed type and by the first bytes;
  25 MB at most. Model `TRANSCRIBE_MODEL` (default `gpt-transcribe`). It uses the same `OPENAI_API_KEY`; without it the
  route answers 503 `dictate_disabled` and `GET /api/me` says `dictate: { available: false }`, so the app hides the button.
- Limits: the `dictate` rate limit (40 an hour) and `DICTATE_DAILY_MAX_MB` (100) of audio in any 24 hours. The bytes
  are counted in the relay's database (`voice_dictation_usage`: a time and a size, nothing else) when the call is sent, so
  a restart keeps the count, and a call OpenAI then fails is not given back. A declared length that cannot fit is refused
  before the body is read.
- Time: the 15 s upload idle guard covers the upload only. After that the relay waits for OpenAI up to
  `DICTATE_TIMEOUT_S`, and the call is cancelled at that deadline or when the app hangs up.
- Errors the app tells apart: `too_large` 413, `unsupported_type` 415, `rate_limited` and `daily_cap` 429,
  `upstream_refused` and `upstream_unreachable` 502, `upstream_timeout` 504 (`DICTATE_TIMEOUT_S`, 90 by default),
  `dictate_disabled` 503.
- App, `apps/web/src/features/composer` (`useDictation.ts`, `DictateUi.tsx`, `dictate.ts`). It reuses `recorder.ts`
  and its microphone permission handling; voice notes are unchanged. Recording stops by itself at 10 minutes, with a
  warning in the last minute. If transcribing fails the recording stays in memory with Try again, Send as voice note or Discard; Dictate, the voice
  note mic and the call button are off until one is chosen. Leaving the thread, or the session ending, drops it.
- The transcript is display text in the box, like typed words. It becomes an owner message only when Send is tapped.

## Settings

Voice picker (`agent.voice`, applies to the next call) and Hands-free versus Hold to talk (per device).

## Testing

- `pnpm exec vitest run` covers the relay (fake provider, fake clock) and the controller and components (jsdom).
- `pnpm --filter @talos-app/web test:e2e` runs `apps/web/test/voice/call.spec.ts` in Chromium with a fake microphone.
- A call against the real service is a manual step: the manual smoke list for wp4.
