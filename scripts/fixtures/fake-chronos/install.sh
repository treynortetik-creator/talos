#!/bin/bash
# A stand-in for Chronos's installer, used ONLY by scripts/test-install.sh. It writes a config and an empty
# jobs.json under $HOME and records the arguments it was given. It never touches launchd.
set -eu
ws=""; noload=0; quiet=0
# (accepts --quiet like Chronos 0.2.1+: the grep in Talos's install.sh looks for that word in THIS file)
while [ $# -gt 0 ]; do case "$1" in --workspace) ws="$2"; shift 2 ;; --no-load) noload=1; shift ;; --quiet) quiet=1; shift ;; *) shift ;; esac; done
cfg="${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}"
mkdir -p "$(dirname "$cfg")" "$HOME/.chronos"
printf '{\n  "workspace": "%s",\n  "jobs_file": "~/.config/chronos/jobs.json",\n  "jobs_dir": "~/.config/chronos/jobs",\n  "notify": ""\n}\n' "$ws" > "$cfg"
echo "[]" > "$HOME/.config/chronos/jobs.json"; mkdir -p "$HOME/.config/chronos/jobs"
echo "install.sh --workspace $ws noload=$noload quiet=$quiet" >> "$HOME/.chronos/fake-install.log"
# like the real installer: write the tick plist. Talos reads the version from the runtime this plist names, never from its own clone.
DIR="$(cd "$(dirname "$0")" && pwd)"; AGENTS="${CHRONOS_LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"; mkdir -p "$AGENTS"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>io.github.chronos.tick</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>%s/bin/chronos-tick.sh</string></array></dict></plist>\n' "$DIR" > "$AGENTS/io.github.chronos.tick.plist"
if [ "$quiet" = 1 ]; then echo "chronos 0.2.2 installed: fake"
else echo "no jobs yet: created an empty jobs.json"; echo "Chronos is installed."; fi
