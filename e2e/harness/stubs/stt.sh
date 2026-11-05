#!/usr/bin/env bash
# Stub speech-to-text: ignores the audio and prints a fixed transcript (argv: the audio file).
[ -f "$1" ] || { echo "no audio file" >&2; exit 2; }
printf 'hello from the stub transcriber'
