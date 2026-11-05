#!/bin/sh
# Test double for TALOS_APP_TTS_CMD: argv is `file <out> <text>`; writes a few bytes to <out>.
printf 'FAKE-AUDIO:%s' "$3" > "$2"
