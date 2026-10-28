---
name: talos-hands-free
description: The user is driving, walking, working out or otherwise cannot look at a screen. Every substantial chat reply ships as audio WITH the full text until the window expires. Use when they say "hands free", "I'm driving", "going for a run", "send audio", "read it to me", or ask for audio for the next hour.
---

# Hands-free mode

**Trigger this when the user says** "hands free", "I'm driving", "heading to the gym", "send me audio", "read it to me",
or anything that clearly means they cannot read a screen for a while. If you are unsure, ask in one line; do not make
them remember to ask.

It needs the phone channel (`setup/telegram.md`) and a way to make audio (`scripts/tts.sh` works with macOS `say` and
nothing else installed; the better voices are optional, see `setup/local-models.md`).

## Turn it on and off

```bash
python3 hooks/hands-free.py on 60       # minutes; default 60, at most 480
python3 hooks/hands-free.py status
python3 hooks/hands-free.py off
```

Confirm in one short line with the end time, then work normally.

## What the mode does (the hook enforces both halves)

While it is on, `hooks/hands-free.py` blocks a turn from ending when:

1. **a substantial chat reply went out as text only** (320 characters or more). Short acknowledgements stay text: a
   four-second clip of "on it" is worse than reading two words;
2. **audio went out with less than about 200 characters of text.** The rule is **audio always travels with the full text**,
   not a caption: the person cannot read right now, but will want to read, search or quote it later, or skim it at a red
   light. An audio-only message cannot be searched or copied.

Each block happens at most once or twice and then the hook lets go, so it can never trap a session. It fails open: a
crash or a missing script blocks nothing. Kill switch: `hands-free.off` (state folder), `TALOS_HANDS_FREE_OFF=1`, or the
Chronos Control Room. The preference alone is not enough; honoured while you are thinking about it, dropped when a turn
runs long. That is why a hook carries it.

## How to produce the audio

1. Write an **ear-optimised narration**: conversational, answer first, no markdown, no URLs, no tables, no `[[wikilinks]]`,
   dashes turned into commas. **Never read a markdown file aloud verbatim**; a raw read is unlistenable.
2. Render it: `bash scripts/tts.sh file narration.m4a "<the narration>"` (or pipe a file in with `-` as the text).
3. Send the audio with the channel reply tool's `files` argument, **and send the full narration text** as chat message(s)
   with it: word for word what the audio says, split near 1,500 characters on paragraph breaks, plain text (Telegram
   shows markdown as raw characters).
4. If a render matters, play it back through `scripts/stt.sh` once. A transcription that drops a sentence means "transcribe
   that segment again", not "the render failed".

## Judgement that stays yours

- **Batch.** Three clips in five minutes is worse than one good one. Let findings accumulate and send one substantial clip.
- **Length.** Keep clips under about four minutes. Past that, split, or write a file for later and say so.
- **Urgency still wins.** Something genuinely time-critical goes out immediately, text first, audio after.
- **The window is a default, not a promise.** If they are clearly still busy, extend it rather than letting it lapse mid-
  conversation. If they start typing full replies again, ask whether to turn it off.

## Related

- `hooks/channel-debt.py`: the same pattern for replying on the channel at all
- `setup/telegram.md`, `setup/local-models.md`: the channel and the optional voices
