#!/usr/bin/env bash
# Stub text-to-speech: argv are {out} and {text}. Writes a tiny but real MP3 frame header so the relay sniffs audio/mpeg.
out="$1"
text="$2"
[ -n "$out" ] || exit 2
[ -n "$text" ] || exit 3
# ID3v2 header followed by an MPEG-1 Layer III frame header and padding.
printf 'ID3\x04\x00\x00\x00\x00\x00\x00\xff\xfb\x90\x00' > "$out"
head -c 1024 /dev/zero >> "$out"
