#!/bin/sh
# A fake `claude` for the permission-card explainer tests. It never talks to anything. It records what it was given into
# $FAKE_DIR (argv NUL-separated, env, cwd, stdin, its pid, one line per call) and then acts out the mode in $FAKE_DIR/mode:
#   ok     print $FAKE_DIR/stdout
#   sleep  start a child that sleeps and wait for it (the timeout test checks both are killed)
#   exit1  print an error and exit 1
#   slow   log start and end lines to $FAKE_DIR/trace around a short pause, then print $FAKE_DIR/stdout
d="$FAKE_DIR"
echo "$$" > "$d/pid"
echo call >> "$d/calls"
: > "$d/argv"
for a in "$@"; do printf '%s\0' "$a" >> "$d/argv"; done
pwd -P > "$d/cwd"
env > "$d/env"
cat > "$d/stdin"
case "$(cat "$d/mode")" in
  ok) cat "$d/stdout" ;;
  sleep) sleep 60 & echo $! > "$d/child"; wait ;;
  exit1) echo oops >&2; exit 1 ;;
  slow) echo start >> "$d/trace"; sleep 0.25; echo end >> "$d/trace"; cat "$d/stdout" ;;
esac
