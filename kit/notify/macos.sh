#!/bin/bash
# Talos notify wrapper: a macOS notification banner. Chronos calls it as:  macos.sh "message"
# Chronos sets CHRONOS_JOB when it knows which job is talking.
msg="${1:-}"; [ -n "$msg" ] || exit 0
title="Talos${CHRONOS_JOB:+: $CHRONOS_JOB}"
# pass the text as an argument, never splice it into the AppleScript source
osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' -- "${msg:0:300}" "$title"
