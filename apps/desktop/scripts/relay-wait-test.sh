#!/usr/bin/env bash
# Tests install.sh's wait for the relay (relay-wait.mjs): a Mac install must not land before the relay serves the same build or
# a newer one. A stub /healthz on this machine plays the relay, a temp HOME holds the Mac's Talos settings, a throwaway git repo
# gives the builds an order, and throwaway ad-hoc signed bundles are installed into temp folders. Stub `osascript`/`open`: no
# real Talos is asked anything and nothing is opened. Usage: relay-wait-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/install.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/talos relay wait.XXXXXX")"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export HOME="$T/home"; mkdir -p "$HOME"
unset TALOS_APP_HOME
export TALOS_RELAY_WAIT_INTERVAL=0.2 TALOS_RELAY_WAIT_LIMIT=3
fails=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fails=$((fails + 1)); }

# Three commits in order: OLD, BUILD (what is installed), NEW.
REPO="$T/repo"
git init -q "$REPO"
gc() { git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m "$1"; git -C "$REPO" rev-parse --short=7 HEAD; }
OLD="$(gc old)"; BUILD_SHA="$(gc build)"; NEW="$(gc new)"
git -C "$REPO" tag web-bundle-new HEAD
git -C "$REPO" branch main-line HEAD
# SIDE: a commit off OLD, on another line than BUILD (an unlanded branch, or a relay deployed from one).
SIDE="$(git -C "$REPO" -c user.name=t -c user.email=t@example.com commit-tree "$OLD^{tree}" -p "$OLD" -m side | cut -c1-7)"

mk_app() {  # mk_app <dir> [git sha]
  mkdir -p "$1/Contents/MacOS"
  cp /usr/bin/true "$1/Contents/MacOS/Talos"
  cat > "$1/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.talos.desktop</string><key>CFBundleExecutable</key><string>Talos</string><key>CFBundlePackageType</key><string>APPL</string><key>TalosCheckout</key><string>$REPO</string></dict></plist>
P
  [ -z "${2:-}" ] || plutil -replace TalosGitSha -string "$2" "$1/Contents/Info.plist"
  codesign --force -s - "$1" 2>/dev/null
}
APP="$T/build/Talos.app"; mk_app "$APP" "$BUILD_SHA"
NOSHA="$T/nosha/Talos.app"; mk_app "$NOSHA"

STUB="$T/stub"; mkdir -p "$STUB"
cat > "$STUB/osascript" <<'S'
#!/bin/bash
case "$2" in *"is running"*) echo false ;; esac
S
printf '#!/bin/bash\necho "open $*" >> "%s/open.log"\n' "$T" > "$STUB/open"
chmod +x "$STUB/osascript" "$STUB/open"
export PATH="$STUB:$PATH"

# The stub relay: answers /healthz with the file $T/answer (first line the status, the rest the body); counts requests.
ANSWER="$T/answer" HITS="$T/hits"
cat > "$T/server.mjs" <<'S'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const [answer, hits, portFile] = process.argv.slice(2)
const srv = createServer((req, res) => {
  appendFileSync(hits, `${req.url}\n`)
  const [status, ...body] = readFileSync(answer, 'utf8').split('\n')
  res.writeHead(Number(status), { 'content-type': 'application/json' })
  res.end(body.join('\n'))
})
srv.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(srv.address().port)))
S
answer() { printf '%s\n%s' "$1" "$2" > "$ANSWER"; }
answer 200 '{"ok":true,"version":"x"}'
: > "$HITS"
node "$T/server.mjs" "$ANSWER" "$HITS" "$T/port" & SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT="$(cat "$T/port")"
[ -n "$PORT" ] || { echo "the stub relay did not start" >&2; exit 2; }
# A port nothing listens on: bind one, then close it.
DEAD="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"

CFG="$HOME/Library/Application Support/Talos"
relay() { mkdir -p "$CFG"; printf '{"relay_url":"%s","keep":"me"}' "$1" > "$CFG/desktop.json"; }
ALL="$T/all-output"; : > "$ALL"
n=0
# inst <args...>: runs install.sh into a fresh folder; sets RC, OUT, D.
inst() {
  n=$((n + 1)); D="$T/dest$n"
  OUT="$(bash "$INSTALL" --dest "$D" --no-open "$@" 2>&1)"; RC=$?
  printf '%s\n' "$OUT" >> "$ALL"
}
has() { case "$OUT" in *"$1"*) return 0 ;; esac; return 1; }
installed() { [ -d "$D/Talos.app" ]; }
hits() { wc -l < "$HITS" | tr -d ' '; }

echo "relay wait"
relay "http://127.0.0.1:$PORT"

answer 200 "{\"ok\":true,\"version\":\"$BUILD_SHA\"}"
inst --app "$APP"
[ "$RC" = 0 ] && installed && has "the same commit as this build" && ok "same version: installs" || bad "same version: rc=$RC $OUT"

answer 200 "{\"ok\":true,\"version\":\"$(git -C "$REPO" rev-parse "$NEW")\"}"
inst --app "$APP"
[ "$RC" = 0 ] && installed && has "newer than this build" && ok "relay newer (a full 40-hex sha): installs" || bad "relay newer: rc=$RC $OUT"
answer 200 "{\"ok\":true,\"version\":\"web-bundle-new-0-g$NEW-dirty\"}"
inst --app "$APP"
[ "$RC" = 0 ] && installed && has "newer than this build" && ok "relay newer (git describe, -dirty): installs" || bad "relay newer (describe): rc=$RC $OUT"
# The describe form resolves only its hex: a tag part that names another commit changes nothing.
answer 200 "{\"ok\":true,\"version\":\"web-bundle-new-3-g$OLD\"}"; : > "$HITS"
TALOS_RELAY_WAIT_LIMIT=0.5 inst --app "$APP"
[ "$RC" = 8 ] && ! installed && has "still on version web-bundle-new-3-g$OLD" && ok "describe form: only the hex is resolved (a newer tag in it is ignored)" || bad "describe hex only: rc=$RC $OUT"

# Not a commit (a tag, a ref name, the package-version fallback): the wait is skipped with one line, no fetch hint.
for v in web-bundle-new 0.1.0 HEAD dev main-line; do
  answer 200 "{\"ok\":true,\"version\":\"$v\"}"
  inst --app "$APP"
  if [ "$RC" = 0 ] && installed && has "the relay reports version $v, not a commit, so it can't be compared; installing" && ! has fetch; then
    ok "version $v is not a commit: skips the wait, says so, installs"
  else bad "not a commit ($v): rc=$RC $OUT"; fi
done

# On another line than the build: stops at once, never waits out the limit.
answer 200 "{\"ok\":true,\"version\":\"$SIDE\"}"; : > "$HITS"
TALOS_RELAY_WAIT_LIMIT=30 inst --app "$APP"
[ "$RC" = 8 ] && ! installed && [ "$(hits)" = 1 ] && has "the relay is on $SIDE, which is not on this build's line ($BUILD_SHA)" && has "--no-relay-wait" \
  && ok "relay on another line: stops (8) after one check" || bad "diverged: rc=$RC hits=$(hits) $OUT"
# git failing to compare is its own stop, not "behind".
REALGIT="$(command -v git)"; mkdir -p "$T/badgit"
printf '#!/bin/bash\ncase " $* " in *" merge-base "*) echo "fatal: bad object" >&2; exit 128 ;; esac\nexec "%s" "$@"\n' "$REALGIT" > "$T/badgit/git"; chmod +x "$T/badgit/git"
answer 200 "{\"ok\":true,\"version\":\"$OLD\"}"; : > "$HITS"
n=$((n + 1)); D="$T/dest$n"
OUT="$(PATH="$T/badgit:$PATH" TALOS_RELAY_WAIT_LIMIT=30 bash "$INSTALL" --app "$APP" --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
[ "$RC" = 8 ] && ! installed && [ "$(hits)" = 1 ] && has "git couldn't compare the relay's version $OLD with this build ($BUILD_SHA)" \
  && ok "a git error while comparing: stops (8) with its own line" || bad "git error: rc=$RC hits=$(hits) $OUT"

# The bundle is rebuilt while install.sh waits: the commit it checked is no longer the one it would install.
CHG="$T/chg/Talos.app"; mk_app "$CHG" "$BUILD_SHA"
answer 200 "{\"ok\":true,\"version\":\"$OLD\"}"
( sleep 1; plutil -replace TalosGitSha -string "$OLD" "$CHG/Contents/Info.plist"; codesign --force -s - "$CHG" 2>/dev/null
  answer 200 "{\"ok\":true,\"version\":\"$NEW\"}" ) & LATER=$!
inst --app "$CHG"
wait "$LATER"
[ "$RC" = 8 ] && ! installed && has "changed while it waited" && ok "a bundle rebuilt during the wait: stops (8)" || bad "changed bundle: rc=$RC $OUT"

# Older, then the deploy lands while it waits.
answer 200 "{\"ok\":true,\"version\":\"$OLD\"}"; : > "$HITS"
( sleep 1; answer 200 "{\"ok\":true,\"version\":\"$NEW\"}" ) & LATER=$!
inst --app "$APP"
wait "$LATER"
[ "$RC" = 0 ] && installed && has "behind this build" && has "newer than this build" && [ "$(hits)" -ge 2 ] \
  && ok "relay older, then caught up within the wait: installs ($(hits) checks)" || bad "catch-up: rc=$RC hits=$(hits) $OUT"

# Older for the whole wait: stops, nothing changes. While it waits, no process carries the address on its command line.
answer 200 "{\"ok\":true,\"version\":\"$OLD\"}"
mkdir -p "$T/keep"; inst --app "$APP" --dest "$T/keep" & IPID=$!
# only this test's own processes (its process group): another process on a busy machine may show the same number
sleep 1; PS="$(ps -o args= -g "$(ps -o pgid= -p $$ | tr -d ' ')")"; wait "$IPID"
OUT="$(bash "$INSTALL" --app "$APP" --dest "$T/keep2" --no-open 2>&1)"; RC=$?; D="$T/keep2"; printf '%s\n' "$OUT" >> "$ALL"
case "$PS" in *"$PORT"*) bad "a process command line carries the relay address" ;; *) ok "no process command line carries the relay address" ;; esac
[ "$RC" = 8 ] && ! installed && [ ! -e "$T/keep2" ] \
  && has "the relay is still on version $OLD while this build is $BUILD_SHA" && has "--no-relay-wait" \
  && ok "relay still older at the limit: stops (8), nothing installed, says so" || bad "timeout: rc=$RC $OUT"
[ -z "$(ls -A "$T/keep")" ] && ok "a stopped wait leaves the folder untouched" || bad "a stopped wait changed the folder: $(ls -A "$T/keep")"

relay "http://127.0.0.1:$DEAD"
inst --app "$APP"
[ "$RC" = 8 ] && ! installed && has "couldn't be reached" && has "--no-relay-wait" && ok "unreachable: stops (8)" || bad "unreachable: rc=$RC $OUT"
relay "http://127.0.0.1:$PORT"

for a in '200|not json' '200|{"ok":false,"version":"abc"}' '200|{"ok":true}' '500|{"ok":true,"version":"abc"}' \
  '200|{"ok":true,"version":"--upload-pack=touch HACKED"}' "200|{\"ok\":true,\"version\":\"$OLD\\u001b[2J\"}"; do
  answer "${a%%|*}" "${a#*|}"
  inst --app "$APP"
  if [ "$RC" = 8 ] && ! installed && has "was not {ok: true, version}" && ! has "upload-pack" && [ ! -e HACKED ] && [ ! -e "$REPO/HACKED" ]; then
    ok "bad answer stops (8): ${a#*|}"
  else bad "bad answer ${a#*|}: rc=$RC $OUT"; fi
done
case "$(cat "$ALL")" in *$'\033'*) bad "a control character from the relay reached the output" ;; *) ok "no control character from the relay reaches the output" ;; esac

answer 200 '{"ok":true,"version":"0123abcd"}'
inst --app "$APP"
[ "$RC" = 8 ] && ! installed && has "which this clone does not have" && ok "a version this clone doesn't have: stops (8)" || bad "unknown commit: rc=$RC $OUT"

answer 200 "{\"ok\":true,\"version\":\"$BUILD_SHA\"}"
inst --app "$NOSHA"
[ "$RC" = 8 ] && ! installed && has "carries no git sha" && ok "a build with no git sha: stops (8)" || bad "no sha: rc=$RC $OUT"

# --no-relay-wait: installs without asking the relay at all.
answer 200 "{\"ok\":true,\"version\":\"$OLD\"}"; : > "$HITS"
inst --app "$APP" --no-relay-wait
[ "$RC" = 0 ] && installed && [ "$(hits)" = 0 ] && has "--no-relay-wait" && ok "--no-relay-wait installs without asking the relay" || bad "--no-relay-wait: rc=$RC hits=$(hits) $OUT"

# --rollback: no wait. Install twice (the second over the first), then roll back while the relay is behind.
D="$T/rb"
answer 200 "{\"ok\":true,\"version\":\"$BUILD_SHA\"}"
bash "$INSTALL" --app "$APP" --dest "$D" --no-open >/dev/null 2>&1 && bash "$INSTALL" --app "$APP" --dest "$D" --no-open >/dev/null 2>&1
answer 200 "{\"ok\":true,\"version\":\"$OLD\"}"; : > "$HITS"
OUT="$(bash "$INSTALL" --rollback --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
[ "$RC" = 0 ] && [ "$(hits)" = 0 ] && has "rolled back" && ok "--rollback skips the wait" || bad "--rollback: rc=$RC hits=$(hits) $OUT"

# Where the address comes from: the placeholder or "auto" falls back to bridge.env, as the app does; nothing set = not paired.
answer 200 "{\"ok\":true,\"version\":\"$BUILD_SHA\"}"; : > "$HITS"
relay "https://relay.example.com/"
mkdir -p "$HOME/.config/talos/app"
printf '# bridge\nexport TALOS_APP_RELAY_URL="http://127.0.0.1:%s" # here\n' "$PORT" > "$HOME/.config/talos/app/bridge.env"
inst --app "$APP"
[ "$RC" = 0 ] && installed && [ "$(hits)" -ge 1 ] && ok "placeholder in desktop.json: reads bridge.env" || bad "bridge.env fallback: rc=$RC hits=$(hits) $OUT"
relay auto
mkdir -p "$T/apphome"; mv "$HOME/.config/talos/app/bridge.env" "$T/apphome/bridge.env"
printf '{"relay_url":"auto","env":{"TALOS_APP_HOME":"%s"}}' "$T/apphome" > "$CFG/desktop.json"; : > "$HITS"
inst --app "$APP"
[ "$RC" = 0 ] && installed && [ "$(hits)" -ge 1 ] && ok "desktop.json env TALOS_APP_HOME: reads that bridge.env" || bad "env app home: rc=$RC hits=$(hits) $OUT"

rm -rf "$CFG" "$T/apphome"; : > "$HITS"
inst --app "$APP"
[ "$RC" = 0 ] && installed && [ "$(hits)" = 0 ] && has "no relay is set" && ok "no relay configured: skips the wait, says so" || bad "not paired: rc=$RC $OUT"

# The check itself breaking (a node that crashes) or missing is a stop with its own line, never an install.
relay "http://127.0.0.1:$PORT"
mkdir -p "$T/crash"; printf '#!/bin/bash\necho "Error: boom at %s" >&2\nexit 3\n' "$T/crash" > "$T/crash/node"; chmod +x "$T/crash/node"
n=$((n + 1)); D="$T/dest$n"
OUT="$(PATH="$T/crash:$PATH" bash "$INSTALL" --app "$APP" --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
[ "$RC" = 8 ] && ! installed && has "the relay check itself failed (exit 3)" && ok "a crashing check stops (8), says so" || bad "crash: rc=$RC $OUT"
# Node is needed only when a relay may be set: a Mac that was never paired installs with no node at all (a clean Mac), and one with a
# relay but no node installs too, saying the relay's version was not checked. An app install never fails for want of node.
NONODE="$STUB:/usr/bin:/bin:/usr/sbin:/sbin"
if PATH="$NONODE" command -v node >/dev/null; then echo "  skip node-missing cases: a node is in /usr/bin"
else
  : > "$HITS"
  n=$((n + 1)); D="$T/dest$n"
  OUT="$(PATH="$NONODE" bash "$INSTALL" --app "$APP" --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
  [ "$RC" = 0 ] && installed && [ "$(hits)" = 0 ] && has "node was not found, so the relay's version was not checked; installing anyway" \
    && ok "relay set, no node: installs (0) and says the relay's version was not checked" || bad "no node, relay set: rc=$RC $OUT"
  rm -rf "$CFG"
  n=$((n + 1)); D="$T/dest$n"
  OUT="$(PATH="$NONODE" bash "$INSTALL" --app "$APP" --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
  [ "$RC" = 0 ] && installed && has "no relay is set" && ! has "node" \
    && ok "no relay, no node (a clean Mac): installs (0), says the wait is skipped, never mentions node" || bad "no node, no relay: rc=$RC $OUT"
  relay "http://127.0.0.1:$PORT"
fi
# No relay set: node is never started (here a node that would crash is first on PATH).
for how in none auto placeholder-bridge-env-unset; do
  rm -rf "$CFG" "$HOME/.config/talos/app"
  case "$how" in
    auto) relay auto ;;
    placeholder-bridge-env-unset)
      relay "https://relay.example.com//"; mkdir -p "$HOME/.config/talos/app"
      printf 'TALOS_APP_RELAY_URL="http://127.0.0.1:%s"\nexport TALOS_APP_RELAY_URL=\n' "$PORT" > "$HOME/.config/talos/app/bridge.env" ;;
  esac
  n=$((n + 1)); D="$T/dest$n"
  OUT="$(PATH="$T/crash:$PATH" bash "$INSTALL" --app "$APP" --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
  [ "$RC" = 0 ] && installed && has "no relay is set" && ! has "relay check itself failed" \
    && ok "no relay ($how): node is never started, installs" || bad "no relay ($how) still ran node: rc=$RC $OUT"
done
# Where the shell is not sure (a desktop.json it cannot parse), relay-wait.mjs decides, as before: the crashing node is asked.
rm -rf "$HOME/.config/talos/app"; mkdir -p "$CFG"; printf 'not json {' > "$CFG/desktop.json"
n=$((n + 1)); D="$T/dest$n"
OUT="$(PATH="$T/crash:$PATH" bash "$INSTALL" --app "$APP" --dest "$D" --no-open 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL"
[ "$RC" = 8 ] && ! installed && has "the relay check itself failed" && ok "a desktop.json the shell cannot read: relay-wait.mjs decides" || bad "unparseable desktop.json: rc=$RC $OUT"
relay "http://127.0.0.1:$PORT"

relay "http://relay.invalid.test:$PORT"
inst --app "$APP"
[ "$RC" = 8 ] && ! installed && has "not one Talos can use" && ok "plain http to another machine is refused (8)" || bad "http non-loopback: rc=$RC $OUT"

case "$(cat "$ALL")" in
  *"$PORT"* | *"$DEAD"* | *127.0.0.1* | *relay.invalid* | *relay.example*) bad "the relay address appears in the output" ;;
  *) ok "the relay address never appears in the output ($(wc -l < "$ALL" | tr -d ' ') lines checked)" ;;
esac
[ ! -e "$T/open.log" ] && ok "nothing was opened" || bad "something was opened: $(cat "$T/open.log")"

if [ "$fails" -gt 0 ]; then echo "relay-wait-test: $fails failing" >&2; exit 1; fi
echo "relay-wait-test: all passed"
