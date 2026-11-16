#!/usr/bin/env bash
# Regression test for install.sh. Runs against ad-hoc signed throwaway bundles, a temp HOME
# and stub `osascript`/`open`, so no real Talos is asked anything and nothing is opened. Every install gets an explicit
# --dest under the temp folder, except the two refusal cases, whose paths can't be written even if the refusal fails.
# FAIL lines are findings; `ok` lines are controls. Usage: review-d6-install-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/install.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/talos rv d6.XXXXXX")"   # a space in the path on purpose
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"
# The relay wait (relay-wait-test.sh) reads the Mac's Talos settings: keep a session's real app home out of these runs.
unset TALOS_APP_HOME
fails=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fails=$((fails + 1)); }

mk_app() {  # mk_app <dir> <bundle id>
  mkdir -p "$1/Contents/MacOS"
  cp /usr/bin/true "$1/Contents/MacOS/Talos"
  cat > "$1/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>$2</string><key>CFBundleExecutable</key><string>Talos</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
P
  codesign --force -s - "$1" 2>/dev/null
}

STUB="$T/stub"; mkdir -p "$STUB"
cat > "$STUB/osascript" <<'S'
#!/bin/bash
# $2 is the -e script. "running" is a file; a quit removes it.
echo "$2" >> "$STUBLOG"
case "$2" in
  *"is running"*) [ -e "$STUBRUN" ] && echo true || echo false ;;
  *"to quit"*) rm -f "$STUBRUN" ;;
esac
S
cat > "$STUB/open" <<'S'
#!/bin/bash
echo "open $*" >> "$STUBLOG"
S
chmod +x "$STUB/osascript" "$STUB/open"
export PATH="$STUB:$PATH" STUBLOG="$T/stub.log" STUBRUN="$T/running"
: > "$STUBLOG"

BUILD="$T/build dir/Talos.app"
mk_app "$BUILD" app.talos.desktop
codesign --verify --strict "$BUILD" 2>/dev/null || { echo "fixture bundle does not verify" >&2; exit 2; }

echo "controls"
D="$T/dest one"
bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1 && [ -d "$D/Talos.app" ] && ok "spaces in --app, --dest and HOME" || bad "spaces in paths broke the install"
bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1 && ok "a second run succeeds" || bad "second run failed"
[ ! -e "$D/.Talos.app.new" ] && [ ! -e "$D/.Talos.app.old" ] && ok "no leftovers" || bad "leftover temp bundles"
touch "$STUBRUN"; : > "$STUBLOG"
bash "$INSTALL" --app "$BUILD" --dest "$D" >/dev/null 2>&1 && ok "installs over a running app" || bad "install over a running app failed"
grep -q 'tell application id "app.talos.desktop" to quit' "$STUBLOG" && ok "the quit names Talos's bundle id" || bad "no quit by bundle id"
grep -q '^open ' "$STUBLOG" && ok "reopens" || bad "did not reopen"
[ ! -e "$HOME/Applications" ] && ok "the real default dest was never used" || bad "wrote to HOME/Applications"
SOCK="talos-test-$$-$RANDOM"
if command -v tmux >/dev/null; then
  tmux -L "$SOCK" -f /dev/null new-session -d -s agent -- sleep 60
  bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1
  tmux -L "$SOCK" has-session -t agent 2>/dev/null && ok "a private tmux session survives" || bad "the tmux session died"
  tmux -L "$SOCK" kill-server 2>/dev/null
fi

echo "findings"
# F: an unrelated Talos.app must not be deleted. install.sh:48,50 moves whatever is there and rm -rf's it.
D="$T/dest two"; mkdir -p "$D/Talos.app"; echo mine > "$D/Talos.app/notes.txt"
bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1
[ -f "$D/Talos.app/notes.txt" ] && ok "a folder that isn't an app survives" || bad "an unrelated folder named Talos.app was deleted (install.sh:48-50)"
D="$T/dest three"; mk_app "$D/Talos.app" com.example.other
bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$D/Talos.app/Contents/Info.plist" 2>/dev/null)" = com.example.other ] \
  && ok "another app called Talos.app survives" || bad "another vendor's Talos.app was replaced (install.sh:48-50)"

# F: --app must be Talos. install.sh:26 takes the id from whatever bundle was passed and asks THAT app to quit.
OTHER="$T/other/Other.app"; mk_app "$OTHER" com.example.notes
D="$T/dest four"; mkdir -p "$D"; touch "$STUBRUN"; : > "$STUBLOG"; mk_app "$D/Talos.app" app.talos.desktop
bash "$INSTALL" --app "$OTHER" --dest "$D" --no-open >/dev/null 2>&1
grep -q 'com.example.notes' "$STUBLOG" && bad "--app <other app> asked that other app to quit (install.sh:26,37)" || ok "only Talos is ever asked to quit"
rm -f "$STUBRUN"

# F: a running Talos with nothing at the target yet (first install while a dev build runs) is not asked to quit, so `open`
# starts a second copy. install.sh:33 gates the quit on the target existing.
D="$T/dest five"; touch "$STUBRUN"; : > "$STUBLOG"
bash "$INSTALL" --app "$BUILD" --dest "$D" >/dev/null 2>&1
grep -q 'to quit' "$STUBLOG" && ok "first install quits a running dev build" || bad "first install leaves the running Talos up and opens a second copy (install.sh:33)"
rm -f "$STUBRUN"

# F: "swaps atomically". If the second mv fails, the install is gone and the next run's rm -rf destroys the only copy.
MVSTUB="$T/mvstub"; mkdir -p "$MVSTUB"
cat > "$MVSTUB/mv" <<'S'
#!/bin/bash
case "$1" in *.Talos.app.new) echo "mv: stubbed failure" >&2; exit 1 ;; esac
exec /bin/mv "$@"
S
chmod +x "$MVSTUB/mv"
D="$T/dest six"; bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1
PATH="$MVSTUB:$PATH" bash "$INSTALL" --app "$BUILD" --dest "$D" --no-open >/dev/null 2>&1
[ -d "$D/Talos.app" ] && ok "a failed swap keeps the old install" || bad "a failed swap leaves no Talos.app; the next run rm -rf's the only copy (install.sh:48-49)"

# F: the refusal is a string match on an unresolved path. Paths under read-only /System, so nothing can land even if it
# isn't refused; the stubbed ditto aborts before any copy.
DSTUB="$T/dstub"; mkdir -p "$DSTUB"; printf '#!/bin/bash\nexit 99\n' > "$DSTUB/ditto"; printf '#!/bin/bash\nexit 0\n' > "$DSTUB/mkdir"; chmod +x "$DSTUB/ditto" "$DSTUB/mkdir"
PATH="$DSTUB:$PATH" bash "$INSTALL" --app "$BUILD" --dest "/tmp/talos-rv-no-such-$$/../../System/talos-rv" --no-open --no-quit >/dev/null 2>&1
[ $? = 2 ] && ok "a dotted path into /System is refused" || bad "a dotted path gets past the system-folder refusal (install.sh:22-24)"

# G: the relaunched app must not inherit a thread session's identity (2026-11-09: install.sh run from a thread session, Main's bridge refused to
# be the live one). `open` gets the environment minus those names, and install.sh says so; a normal run says nothing about it.
OSTUB="$T/ostub"; mkdir -p "$OSTUB"
cat > "$OSTUB/open" <<'S'
#!/bin/bash
/usr/bin/env > "$OPENENV"
S
chmod +x "$OSTUB/open"
export OPENENV="$T/open.env"
D="$T/dest seven"
OUT="$(TALOS_APP_WORKER_THREAD=talos TALOS_SESSION_ROLE=worker TALOS_APP_WORKER_NONCE=0123abcd TELEGRAM_STATE_DIR=/t/workers/_nochannel IMESSAGE_STATE_DIR=/own/imessage ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_SESSION_ID=x CLAUDE_CODE_ENTRYPOINT=cli KEEP_ME=1 PATH="$OSTUB:$PATH" bash "$INSTALL" --app "$BUILD" --dest "$D" --no-quit 2>&1)"
if [ -s "$OPENENV" ]; then
  leaked="$(grep -E '^(TALOS_APP_WORKER_THREAD|TALOS_SESSION_ROLE|TALOS_APP_WORKER_NONCE|CLAUDE_CODE_[A-Z_]*)=' "$OPENENV" | cut -d= -f1 | tr '\n' ' ')"
  [ -z "$leaked" ] && ok "open is run without a thread session's identity or Claude Code session vars" || bad "open inherits: $leaked"
  grep -q '^TELEGRAM_STATE_DIR=' "$OPENENV" && bad "open inherits a worker's TELEGRAM_STATE_DIR" || ok "a worker's no-channel state dir is dropped"
  grep -q '^IMESSAGE_STATE_DIR=/own/imessage$' "$OPENENV" && ok "the owner's own state dir stays" || bad "the owner's own IMESSAGE_STATE_DIR was dropped"
  grep -q '^ENABLE_CLAUDEAI_MCP_SERVERS=' "$OPENENV" && bad "open inherits ENABLE_CLAUDEAI_MCP_SERVERS" || ok "the claude.ai connectors switch is dropped"
  grep -q '^KEEP_ME=1$' "$OPENENV" && ok "the rest of the environment is kept" || bad "the scrub dropped an unrelated variable"
else
  bad "the stub open was never run"
fi
case "$OUT" in *"thread session"*"scrubbed"*|*"scrubbed"*"thread session"*) ok "it says it ran from a thread session and scrubbed" ;; *) bad "no note about the thread session: $OUT" ;; esac
rm -f "$OPENENV"
OUT="$(env -u TALOS_APP_WORKER_THREAD -u TALOS_SESSION_ROLE -u TALOS_APP_WORKER_NONCE PATH="$OSTUB:$PATH" bash "$INSTALL" --app "$BUILD" --dest "$D" --no-quit 2>&1)"
case "$OUT" in *scrubbed*) bad "a normal run claims it scrubbed something: $OUT" ;; *) ok "a normal run says nothing about it" ;; esac

echo "$fails finding(s)"
exit "$((fails > 0 ? 1 : 0))"
