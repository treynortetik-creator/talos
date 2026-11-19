#!/usr/bin/env bash
# Publishes a signed Mac release on the public repo's GitHub Releases, where the app's updater finds it: the notarized zip, its .sha256,
# latest.json and latest.json.sig (release-app.sh, then release-sign-manifest.sh). Run by hand, as the owner, on the "release" word.
#   release-publish.sh <tag> [--dry-run] [--dir DIR] [--repo OWNER/NAME] [--ci-repo OWNER/NAME] [--summary-file FILE]
#     <tag>           the release's tag; it must already be on the public repo, at the public snapshot of the commit the app
#                     was built from
#     --dry-run       every check and the notes, then stop before anything is created or uploaded
#     --dir           release-app.sh's --out folder (default: apps/desktop/.build/release)
#     --repo          the public repo (default: treynortetik-creator/talos)
#     --ci-repo       where local CI posts its statuses (default: this clone's origin on GitHub)
#     --summary-file  a short summary for strangers, plain text, at most 600 characters (default: the notes say only what the
#                     release is); it goes through the personal-data check with the rest of the notes
# The public repo is a squashed snapshot that shares no commits with the private one. Its snapshot commit names the private commit it
# was made from in a trailer, `Talos-Source: <private sha>` (scripts/publish-public.sh). latest.json's git_sha is the PUBLIC commit
# (where a beta Mac's checkout moves); CI and the app build belong to the PRIVATE one. It refuses (and uploads nothing) unless, in order:
#   0. gh is signed in as treynortetik-creator (never another account; this script never switches);
#   1. the folder holds latest.json and its .sig, the zip and its .sha256, and they agree (latest.json's zip, sha256, size, tag), and
#      latest.json verifies with a release key the app pins (once one is pinned);
#   2. the tag is on the public repo and points at latest.json's git_sha (an app is never ahead of the public code);
#   3. that public commit carries a Talos-Source trailer, and it is the commit the app was built from (release-app.sh's source_sha);
#   4. that private commit has all six local-ci statuses (check mod browser image desktop mobile) final and green on --ci-repo: the
#      newest of each is "success" and says "passed on ...", or, for a job other than check, "skipped: no <job> inputs changed since <sha>";
#   5. the release notes, made from a fixed template, pass scripts/check-no-personal.sh (with the private list when this clone has one).
# Then: `gh release create` on the public repo with the notes and the four files (a release that already exists is refused, never
# changed). gh must be signed in to an account that may write the public repo; this script never signs in or switches accounts.
# Output: one line, `release <version>: ok` (or `release <version>: dry run ok`), else `FAILED: <why>`. Exit 0 or 1; 64 bad arguments.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
TAG="" DRY=0 DIR="$HERE/.build/release" PUB="treynortetik-creator/talos" CIREPO="" SUMMARY=""
fail() { echo "FAILED: $1"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --dir|--repo|--ci-repo|--summary-file)
      [ $# -ge 2 ] || { echo "FAILED: $1 needs a value"; exit 64; }
      case "$1" in --dir) DIR="$2" ;; --repo) PUB="$2" ;; --ci-repo) CIREPO="$2" ;; --summary-file) SUMMARY="$2" ;; esac
      shift 2 ;;
    -*) echo "FAILED: unknown argument $1"; exit 64 ;;
    *) [ -z "$TAG" ] || { echo "FAILED: one tag only"; exit 64; }; TAG="$1"; shift ;;
  esac
done
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "FAILED: usage: release-publish.sh <tag> [--dry-run]"; exit 64; }
[[ "$PUB" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "FAILED: --repo must be OWNER/NAME"; exit 64; }
if [ -z "$CIREPO" ]; then
  CIREPO="$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+)$#\2#p' | sed 's/\.git$//')"
fi
[[ "$CIREPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "could not tell which repo holds the CI statuses; pass --ci-repo"
command -v node >/dev/null || fail "node is needed"
command -v gh >/dev/null || fail "gh is needed"
export GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0
OWNER_LOGIN="treynortetik-creator"
LOGIN="$(gh api user --jq .login </dev/null 2>/dev/null)" || fail "gh is not signed in (gh auth status)"
[ "$LOGIN" = "$OWNER_LOGIN" ] || fail "gh is signed in as ${LOGIN:-nobody}, not $OWNER_LOGIN; this script never switches accounts"

# 1. The files, and that they agree with each other (the signature itself was checked when it was made; the app checks it again).
[ -d "$DIR" ] || fail "$DIR is not a folder"
DIR="$(cd "$DIR" && pwd -P)"
for f in latest.json latest.json.sig; do [ -s "$DIR/$f" ] || fail "$f is missing from $DIR (run release-sign-manifest.sh)"; done
FIELDS="$(node --disable-warning=ExperimentalWarning --input-type=module -e '
const [proto, dir, tag] = process.argv.slice(1)
const fs = await import("node:fs")
const crypto = await import("node:crypto")
const p = await import(proto)
const r = p.parseReleaseManifest(JSON.parse(fs.readFileSync(`${dir}/latest.json`, "utf8")))
if (!r.ok) { process.stdout.write(`bad latest.json: ${r.why}`); process.exit(1) }
const m = r.manifest
// the signature against the keys the app pins (while it pins none, the app installs nothing anyway)
if (p.RELEASE_KEYS.length > 0) {
  const v = p.verifyReleaseManifest(fs.readFileSync(`${dir}/latest.json`), fs.readFileSync(`${dir}/latest.json.sig`, "utf8"), { keys: [...p.RELEASE_KEYS], retired: [] })
  if (!v.ok) { process.stdout.write(`latest.json does not verify with the pinned release key (${v.why})`); process.exit(1) }
}
if (m.tag !== tag) { process.stdout.write(`latest.json is for tag ${m.tag}, not ${tag}`); process.exit(1) }
const zip = `${dir}/${m.zip_name}`
if (!fs.existsSync(zip) || !fs.existsSync(`${zip}.sha256`)) { process.stdout.write(`${m.zip_name} or its .sha256 is missing`); process.exit(1) }
const bytes = fs.readFileSync(zip)
const sha = crypto.createHash("sha256").update(bytes).digest("hex")
const line = fs.readFileSync(`${zip}.sha256`, "utf8").trim().split(/\s+/)[0]
if (sha !== m.zip_sha256 || line !== sha || bytes.length !== m.size) { process.stdout.write("the zip, its .sha256 and latest.json disagree"); process.exit(1) }
process.stdout.write(`${m.version}\t${m.git_sha}\t${m.zip_name}`)
' "$ROOT/packages/protocol/src/release-manifest.ts" "$DIR" "$TAG" 2>&1)" || fail "${FIELDS:-could not read latest.json}"
IFS=$'\t' read -r VERSION SHA ZIPNAME <<<"$FIELDS"

# 2. The tag on the public repo, at latest.json's commit.
PUBSHA="$(gh api "repos/$PUB/commits/$TAG" --jq .sha </dev/null 2>/dev/null)" || fail "tag $TAG is not on $PUB (push the public code snapshot first)"
[ "$PUBSHA" = "$SHA" ] || fail "tag $TAG on $PUB is ${PUBSHA:0:7}, but latest.json names ${SHA:0:7}; an app is never ahead of the public code"

# 3. The private commit the snapshot was made from (its Talos-Source trailer), and the build's own record of its source.
MSG="$(gh api "repos/$PUB/commits/$SHA" --jq .commit.message </dev/null 2>/dev/null)" || fail "could not read the public commit ${SHA:0:7}"
SRC="$(printf '%s\n' "$MSG" | git interpret-trailers --parse 2>/dev/null | sed -nE 's/^Talos-Source: ([0-9a-f]{40})$/\1/p' | tail -1)"
[ -n "$SRC" ] || fail "the public commit ${SHA:0:7} has no Talos-Source trailer naming the private commit it was made from"
shopt -s nullglob
BUILT=("$DIR"/Talos-*.manifest.json)
shopt -u nullglob
[ "${#BUILT[@]}" = 1 ] || fail "$DIR must hold exactly one Talos-*.manifest.json from release-app.sh"
BUILT_SRC="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).source_sha||""))' "${BUILT[0]}")"
[ "$BUILT_SRC" = "$SRC" ] || fail "the app was built from ${BUILT_SRC:0:7}, but the public snapshot was made from ${SRC:0:7}"

# 4. The six local-ci statuses on that private commit, newest first per context.
ROWS="$(gh api --paginate "repos/$CIREPO/commits/$SRC/statuses?per_page=100" --jq '.[] | [.context, .state, .description] | @tsv' </dev/null 2>/dev/null)" \
  || fail "could not read the CI statuses of ${SRC:0:7} on $CIREPO"
for job in check mod browser image desktop mobile; do
  row="$(printf '%s\n' "$ROWS" | awk -F'\t' -v c="local-ci/$job" '$1 == c { print; exit }')"
  [ -n "$row" ] || fail "${SRC:0:7} has no local-ci/$job status (CI must pass all six before a release)"
  state="$(printf '%s' "$row" | cut -f2)" desc="$(printf '%s' "$row" | cut -f3)"
  [ "$state" = success ] || fail "local-ci/$job on ${SRC:0:7} is $state, not success"
  case "$desc" in
    "passed on "*) ;;
    "skipped: no $job inputs changed since "*)
      [ "$job" != check ] && [[ "${desc##* since }" =~ ^[0-9a-f]{7,40}$ ]] || fail "local-ci/$job on ${SRC:0:7} was skipped, not passed" ;;
    *) fail "local-ci/$job on ${SRC:0:7} says \"$desc\", not a pass" ;;
  esac
done

# 5. The notes: a fixed template, then the personal-data check over exactly them.
NOTES_DIR="$(mktemp -d)"
trap 'rm -rf "$NOTES_DIR"' EXIT
TEXT=""
if [ -n "$SUMMARY" ]; then
  [ -f "$SUMMARY" ] || fail "--summary-file $SUMMARY is not a file"
  TEXT="$(tr -d '\r' < "$SUMMARY")"
  [ "${#TEXT}" -le 600 ] || fail "the summary is over 600 characters"
fi
{
  printf 'Talos %s for Mac\n\n' "$VERSION"
  printf 'Released %s.\n\n' "$(date -u +%Y-%m-%d)"
  [ -z "$TEXT" ] || printf '%s\n\n' "$TEXT"
  printf 'A signed and notarized build of the Talos Mac app. Installed copies with automatic updates on pick it up by themselves; each one checks this release against a key built into the app before it installs it.\n'
} > "$NOTES_DIR/release-notes.md"
CHECK_ALL_FILES=1 bash "$ROOT/scripts/check-no-personal.sh" "$NOTES_DIR" >/dev/null 2>&1 || fail "the release notes did not pass the personal-data check"

# The source tarball (R2-2): when the app in the zip carries TalosSourceSHA256, its first setup downloads talos-source-<tag>.tar.gz from
# this release and checks that hash. So that asset MUST be in the folder (release-app.sh made it) with exactly that sha256, and goes up with
# the rest; a missing or different one fails the publish (the app would be unable to set itself up).
SRC_ASSETS=()
STAMP=""
if unzip -p "$DIR/$ZIPNAME" "Talos.app/Contents/Info.plist" > "$NOTES_DIR/zip-Info.plist" 2>/dev/null; then
  STAMP="$(/usr/libexec/PlistBuddy -c 'Print :TalosSourceSHA256' "$NOTES_DIR/zip-Info.plist" 2>/dev/null || true)"
fi
if [ -n "$STAMP" ]; then
  SRC="$DIR/talos-source-$TAG.tar.gz"
  [ -f "$SRC" ] || fail "the app carries TalosSourceSHA256, so $(basename "$SRC") must be published with it, and it is not in $DIR"
  [ "$(shasum -a 256 "$SRC" | awk '{print $1}')" = "$STAMP" ] || fail "$(basename "$SRC") is not the file the app's TalosSourceSHA256 names"
  [ -f "$SRC.sha256" ] || printf '%s  %s\n' "$STAMP" "$(basename "$SRC")" > "$NOTES_DIR/$(basename "$SRC").sha256"
  SRC_ASSETS=("$SRC")
  [ -f "$SRC.sha256" ] && SRC_ASSETS+=("$SRC.sha256") || SRC_ASSETS+=("$NOTES_DIR/$(basename "$SRC").sha256")
fi

if [ "$DRY" = 1 ]; then echo "release $VERSION: dry run ok"; exit 0; fi
gh release view "$TAG" --repo "$PUB" >/dev/null 2>&1 </dev/null && fail "a release for $TAG already exists on $PUB; it is never changed in place"
ASSETS=("$DIR/$ZIPNAME" "$DIR/$ZIPNAME.sha256" "$DIR/latest.json" "$DIR/latest.json.sig")
gh release create "$TAG" --repo "$PUB" --verify-tag --title "Talos $VERSION" --notes-file "$NOTES_DIR/release-notes.md" \
  "${ASSETS[@]}" ${SRC_ASSETS[@]+"${SRC_ASSETS[@]}"} </dev/null >/dev/null 2>&1 \
  || fail "gh release create failed on $PUB"
echo "release $VERSION: ok"
