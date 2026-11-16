#!/bin/bash
# Shared helpers for the black-screen repro. Sourced by repro.sh. Every process is found by parent pid (the simulator's
# launchd_sim), never by a name match across the machine.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM="${TALOS_REPRO_SIM:-$(cat "$HERE/.sim-udid" 2>/dev/null)}"
APP_ID="${TALOS_REPRO_APP_ID:-app.talos.shell}"

sim_launchd() { ps -axo pid=,comm= | awk -v u="$SIM" '/launchd_sim/ {print $1}' | while read -r p; do
  ps -o command= -p "$p" | grep -q "$SIM" && echo "$p"; done | head -1; }
# pid of one of the simulator's WebKit helpers: WebContent, GPU or Networking
webkit_pid() { ps -axo pid=,ppid=,comm= | awk -v p="$(sim_launchd)" -v n="/com.apple.WebKit.$1$" '$2==p && $0 ~ n {print $1}' | head -1; }
app_pid() { ps -axo pid=,ppid=,comm= | awk -v p="$(sim_launchd)" '$2==p && $0 ~ /App\.app\/App$/ {print $1}' | head -1; }
background() { xcrun simctl launch "$SIM" com.apple.Preferences >/dev/null; sleep "${1:-3}"; }
foreground() { xcrun simctl launch "$SIM" "$APP_ID" >/dev/null; }
shot() { xcrun simctl io "$SIM" screenshot "$1" >/dev/null 2>&1 && echo "shot $1"; }
