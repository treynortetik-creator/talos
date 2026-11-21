#!/usr/bin/env bash
# The release image's filesystem scan (.github/workflows/relay-image.yml runs it BEFORE any login or push):
#
#   scripts/relay-image-scan.sh DIR        DIR is the image's filesystem, exported with `docker create` + `docker export`
#
# It looks at /app only (the Dockerfile's WORKDIR: everything the Dockerfile adds). The base image (Debian, node) is not ours: its
# absolute links, licence files with addresses and CA certificates are none of this scan's business.
# Fails (exit 1) on, inside app/: a file named .env*, *.pem, *.key, id_*, *.p12; an .npmrc that carries a token; a .git folder; a
# link with an absolute target (it would read the host's file); a private key block with a key body, or a GitHub, Anthropic, AWS or
# Slack token, in any file (node_modules too); anything scripts/check-no-personal.sh (its generic list) refuses. The content
# patterns match real-looking values only, so a redactor's own regexes in the bundle do not trip them, and there is no file
# exemption. Hits print the path only, never the matched text. Prints the file counts and the top-level folders of app. A missing or
# empty app folder is an error (exit 2), so an export that failed cannot read as a clean image. This lives in scripts/ because a
# workflow folder holds workflows only and a test must be able to run it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${1:-}"
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "relay-image-scan: usage: relay-image-scan.sh DIR (an exported image folder)" >&2; exit 2; }
DIR="$(cd "$DIR" && pwd)"
APP="$DIR/app"
[ -d "$APP" ] || { echo "relay-image-scan: the image has no app folder; the export failed or the Dockerfile changed" >&2; exit 2; }
APP_COUNT="$(find "$APP" \( -type f -o -type l \) | wc -l | tr -d ' ')"
[ "$APP_COUNT" -gt 0 ] || { echo "relay-image-scan: the app folder has no files; the export failed" >&2; exit 2; }
IMAGE_COUNT="$(find "$DIR" \( -type f -o -type l \) | wc -l | tr -d ' ')"

HITS="$(mktemp)"
KEEP="$(mktemp)"
trap 'rm -f "$HITS" "$KEEP"' EXIT
rel() { sed "s#^$DIR/##"; }

find "$APP" \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_*' -o -name '*.p12' \) \
  \( -type f -o -type l \) 2>/dev/null | rel | sed 's#^#[secret file] #' >>"$HITS"
find "$APP" -name .git 2>/dev/null | rel | sed 's#^#[.git] #' >>"$HITS"
find "$APP" -type l -lname '/*' 2>/dev/null | rel | sed 's#^#[absolute link] #' >>"$HITS"
find "$APP" -name .npmrc -type f -print0 2>/dev/null \
  | xargs -0 -r grep -lEi '_authToken|_auth[ =]|_password' 2>/dev/null | rel | sed 's#^#[npmrc token] #' >>"$HITS" || true
# Real-looking values only (a key body after the BEGIN line, a long token tail), in every file, binaries read as text.
find "$APP" -type f -print0 2>/dev/null \
  | LC_ALL=C xargs -0 -r grep -laE \
      -e 'gh[opsu]_[A-Za-z0-9]{20,}' -e 'github_pat_[A-Za-z0-9_]{20,}' -e 'sk-ant-[A-Za-z0-9_-]{20,}' \
      -e 'AKIA[0-9A-Z]{16}' -e 'xox[abp]-[A-Za-z0-9-]{10,}' 2>/dev/null | rel | sed 's#^#[secret text] #' >>"$HITS" || true
# The key block spans lines (or sits in a JSON string with a literal \n), so that one is read with -z: a whole file is one record.
find "$APP" -type f -print0 2>/dev/null \
  | LC_ALL=C xargs -0 -r grep -lazE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----(\\n|[[:space:]])*[A-Za-z0-9+/]{40,}' 2>/dev/null \
  | tr '\0' '\n' | rel | sed 's#^#[private key] #' >>"$HITS" || true

if [ -s "$HITS" ]; then
  echo "relay-image-scan: FAILED" >&2
  sort -u "$HITS" >&2
  exit 1
fi
# The generic personal-data rules over app (not a git checkout; node_modules is skipped by that script's own rule). One
# exception, because the repo's own check exempts third_party/ for the same reason: the e-mail rule fires on author addresses in
# the licence banners of third-party code the web build bundles (app/web/assets/*.js, *.js.map, *.css). Only that rule on only
# those files is ignored (found by the rule's text, not its line number); every other hit fails. Its paths are relative to app.
EMAIL_LINE="$(grep -n -F '[A-Za-z0-9._%+-]+@' "$HERE/denylist.generic.txt" | head -n 1 | cut -d: -f1)"
rc=0
CHECK_NO_GIT=1 bash "$HERE/check-no-personal.sh" "$APP" >/dev/null 2>"$HITS" || rc=$?
if [ "$rc" -ne 0 ]; then
  grep -E '^\[' "$HITS" | grep -vE "^\[denylist\.generic\.txt rule line ${EMAIL_LINE:-0}\] web/assets/[^:]+\.(js|js\.map|css):[0-9]+$" | sed 's#\] #] app/#' >"$KEEP" || true
  if [ "$rc" -ne 1 ] || [ -s "$KEEP" ]; then
    echo "relay-image-scan: FAILED (check-no-personal.sh, exit $rc)" >&2
    if [ -s "$KEEP" ]; then cat "$KEEP" >&2; else cat "$HITS" >&2; fi
    exit 1
  fi
fi
echo "relay-image-scan: ok, $APP_COUNT files in app ($IMAGE_COUNT in the image); top-level of app: $(cd "$APP" && LC_ALL=C ls -A | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
