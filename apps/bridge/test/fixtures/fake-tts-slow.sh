#!/bin/sh
# Test double for TALOS_APP_TTS_CMD that takes its time: argv is `file <out> <text> [<gate>]`; waits, then writes <out>.
# With a <gate> path it waits until that file exists (the test decides when speech may finish); the wait gives up after
# about a minute so a test that dies leaves nothing behind. Without one it sleeps 3 seconds.
if [ -n "$4" ]; then
  n=0
  while [ ! -e "$4" ] && [ "$n" -lt 1200 ]; do sleep 0.05; n=$((n + 1)); done
else
  sleep 3
fi
printf 'FAKE-AUDIO:%s' "$3" > "$2"
