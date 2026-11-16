#!/usr/bin/env bash
# Writes and signs the release manifest the Mac app's updater reads: latest.json (the JCS form of the manifest) and latest.json.sig
# (the raw, low-S ECDSA P-256 signature over its bytes behind the domain line, made by release-key.swift with the Secure Enclave key;
# packages/protocol/src/release-manifest.ts), beside the zip that release-app.sh made, from that run's own .manifest.json.
#   release-sign-manifest.sh --tag TAG [--dir DIR] [--min-app-version X.Y.Z] [--repo OWNER/NAME] [--public-url URL] [--source-repo DIR]
#                            [--keys-update FILE]
#     --keys-update      a key rotation for the app to apply, JSON {"add":[{"kid","pub"}],"retire":[kid]}: signed into this manifest
#                        by the current key (the app keeps it only because the manifest verifies under a key it trusts now)
#     --tag              the release's tag on the public repo (letters, digits, . _ -); the zip's address is built from it
#     --public-url       where git fetches the public repo from (default: https://github.com/<--repo>.git)
#     --source-repo      the private clone that holds the commit the app was built from (default: this clone)
# The manifest's git_sha is the public snapshot commit the tag points at: the commit every beta Mac's checkout moves to, runs
# `pnpm install` in and takes install.sh from. So it is taken from local truth, never from an API answer, and checked before
# anything is signed: git fetches the tag from the public repo; its commit's Talos-Source trailer must name the build's
# source_sha (release-app.sh); and its TREE must equal the tree of a fresh export of that private commit, made here with that
# commit's own scripts/export-public.sh. A tag moved to another commit (even one carrying a copied trailer) has another tree and
# is refused. This holds with no snapshot clone kept anywhere.
#     --dir              release-app.sh's --out folder (default: apps/desktop/.build/release); it must hold exactly one notarized
#                        Talos-*.manifest.json and its zip
#     --min-app-version  the oldest app that may update itself to this release (default 0.0.0: any)
#     --repo             the public repo whose release holds the files (default: treynortetik-creator/talos)
# The key: TALOS_RELEASE_KEY, the path of the key file release-key.swift created (by convention ~/.config/talos/release-key/<kid>.se,
# readable by this user only, outside this clone). Its Secure Enclave blob signs only on this Mac and never leaves it; nothing here
# reads or prints a private key. A software key (tests) signs only with TALOS_RELEASE_KEY_ALLOW_SOFTWARE=1.
# The signature is checked with the key's own public half before anything is written, and against the keys pinned in the app
# (`RELEASE_KEYS`): a kid that is not pinned is refused. While the app pins none (the placeholder) it says so loudly, because no app
# will install the release. The committed TEST keys are always refused.
# Exit codes: 0 written; 1 a check failed (it says which); 64 bad arguments; 65 something it needs is missing (key, node, files).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
DIR="$HERE/.build/release" TAG="" MIN="0.0.0" PUBLIC_REPO="treynortetik-creator/talos" PUBLIC_URL="" SOURCE_REPO="$REPO_ROOT" KEYS_UPDATE=""
die() { echo "release-sign-manifest: $1" >&2; exit "${2:-1}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) [ $# -ge 2 ] || die "--tag needs a value" 64; TAG="$2"; shift 2 ;;
    --public-url) [ $# -ge 2 ] || die "--public-url needs a URL" 64; PUBLIC_URL="$2"; shift 2 ;;
    --source-repo) [ $# -ge 2 ] || die "--source-repo needs a folder" 64; SOURCE_REPO="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a folder" 64; DIR="$2"; shift 2 ;;
    --min-app-version) [ $# -ge 2 ] || die "--min-app-version needs a version" 64; MIN="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs OWNER/NAME" 64; PUBLIC_REPO="$2"; shift 2 ;;
    --keys-update) [ $# -ge 2 ] || die "--keys-update needs a file" 64; KEYS_UPDATE="$2"; shift 2 ;;
    *) die "unknown argument $1" 64 ;;
  esac
done
[[ "$TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "--tag is required (letters, digits, . _ -)" 64
[[ "$MIN" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "--min-app-version must be X.Y.Z" 64
[[ "$PUBLIC_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be OWNER/NAME" 64
[ -n "$PUBLIC_URL" ] || PUBLIC_URL="https://github.com/$PUBLIC_REPO.git"
command -v node >/dev/null || die "node is needed" 65
[ -d "$DIR" ] || die "$DIR is not a folder (run release-app.sh first)" 65
DIR="$(cd "$DIR" && pwd -P)"
shopt -s nullglob
MANIFESTS=("$DIR"/Talos-*.manifest.json)
shopt -u nullglob
[ "${#MANIFESTS[@]}" = 1 ] || die "$DIR must hold exactly one Talos-*.manifest.json from release-app.sh (it holds ${#MANIFESTS[@]})" 65

# The public commit, from local truth: the tag fetched by git, its trailer, and its tree against a fresh export of the build's source.
SOURCE_SHA="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).source_sha||""))' "${MANIFESTS[0]}")"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "the build does not record the commit it was built from (source_sha): run this release-app.sh again"
export GIT_TERMINAL_PROMPT=0
WORKT="$(mktemp -d)"
trap 'rm -rf "$WORKT"' EXIT
git init -q --bare "$WORKT/public.git"
git -C "$WORKT/public.git" fetch --quiet --no-tags "$PUBLIC_URL" "+refs/tags/$TAG:refs/tags/$TAG" </dev/null >/dev/null 2>&1 \
  || die "could not fetch tag $TAG from the public repo (publish the public snapshot and tag it first)"
PUBLIC_COMMIT="$(git -C "$WORKT/public.git" rev-parse --verify --quiet "refs/tags/$TAG^{commit}")" || die "tag $TAG names no commit"
TRAILER="$(git -C "$WORKT/public.git" log -1 --format=%B "$PUBLIC_COMMIT" | git interpret-trailers --parse | sed -nE 's/^Talos-Source: ([0-9a-f]{40})$/\1/p' | tail -1)"
[ "$TRAILER" = "$SOURCE_SHA" ] || die "the public commit ${PUBLIC_COMMIT:0:7} says it was made from ${TRAILER:-nothing}, but the app was built from ${SOURCE_SHA:0:7}"
git -C "$SOURCE_REPO" cat-file -e "$SOURCE_SHA^{commit}" 2>/dev/null || die "the build's source commit ${SOURCE_SHA:0:7} is not in $SOURCE_REPO" 65
git clone --quiet --no-checkout --shared "$SOURCE_REPO" "$WORKT/source" </dev/null >/dev/null 2>&1 && git -C "$WORKT/source" checkout --quiet --detach "$SOURCE_SHA" </dev/null \
  || die "could not check out ${SOURCE_SHA:0:7} to export it"
EXPORT_SOURCE="$WORKT/source" bash "$WORKT/source/scripts/export-public.sh" "$WORKT/export" >/dev/null 2>&1 || die "the export of ${SOURCE_SHA:0:7} failed"
git init -q "$WORKT/tree"
cp -R "$WORKT/export/." "$WORKT/tree/"
git -C "$WORKT/tree" add -A --force
WANT_TREE="$(git -C "$WORKT/tree" write-tree)"
GOT_TREE="$(git -C "$WORKT/public.git" rev-parse "$PUBLIC_COMMIT^{tree}")"
[ "$WANT_TREE" = "$GOT_TREE" ] || die "tag $TAG points at ${PUBLIC_COMMIT:0:7}, whose files are not the export of ${SOURCE_SHA:0:7}; nothing was signed"

# The key: a file this user alone can read, outside the clone, or a keychain item. Never both, never neither.
KEY_FILE="${TALOS_RELEASE_KEY:-}"
[ -n "$KEY_FILE" ] || die "set TALOS_RELEASE_KEY to the release key file (release-key.swift create)" 65
[ -f "$KEY_FILE" ] && [ ! -L "$KEY_FILE" ] || die "TALOS_RELEASE_KEY does not name a regular file" 65
case "$(stat -f %Lp "$KEY_FILE")" in 600|400) ;; *) die "the key file must be readable by its owner only (chmod 600)" 65 ;; esac
case "$(cd "$(dirname "$KEY_FILE")" && pwd -P)/" in "$REPO_ROOT"/*) die "the key file is inside this clone; keep it outside the repo" 65 ;; esac
KEYTOOL=(swift "$HERE/scripts/release-key.swift")
SOFT=()
[ "${TALOS_RELEASE_KEY_ALLOW_SOFTWARE:-}" = 1 ] && SOFT=(--allow-software)
PINLINE="$("${KEYTOOL[@]}" pub --key "$KEY_FILE" 2>/dev/null | sed -n 's/^pin //p')" || die "the release key could not be loaded (a Secure Enclave key works only on the Mac that made it)"
KID="$(printf '%s' "$PINLINE" | sed -nE "s/.*kid: '([0-9a-f]{16})'.*/\1/p")"
PUB="$(printf '%s' "$PINLINE" | sed -nE "s/.*publicKey: '([A-Za-z0-9+\/=]+)'.*/\1/p")"
[ -n "$KID" ] && [ -n "$PUB" ] || die "the release key gave no public key"
UPDATE_JSON="null"
if [ -n "$KEYS_UPDATE" ]; then [ -f "$KEYS_UPDATE" ] || die "--keys-update $KEYS_UPDATE is not a file" 64; UPDATE_JSON="$(cat "$KEYS_UPDATE")"; fi

# 1. The manifest, built by the protocol's own code, written as latest.json.tmp.
BUILD_JS='
const [protoPath, mPath, dir, tag, min, repo, publicCommit, kid, update] = process.argv.slice(1)
const fs = await import("node:fs")
const crypto = await import("node:crypto")
const p = await import(protoPath)
const built = JSON.parse(fs.readFileSync(mPath, "utf8"))
const fail = (why) => { process.stderr.write(`release-sign-manifest: ${why}\n`); process.exit(1) }
if (built.notarized !== true || built.stapled !== true) fail("the build is not notarized and stapled (release-app.sh without --no-notarize)")
if (!/^[0-9a-f]{40}$/.test(built.source_sha ?? "")) fail("the build does not record the commit it was built from (source_sha): run this release-app.sh again")
if (publicCommit === built.source_sha) fail("the public commit is the private one; the public repo is a snapshot of its own (Talos-Source names the private commit)")
if (p.RELEASE_TEST_KEYS.some((k) => k.kid === kid)) fail("this is a committed TEST key; a release is never signed with it")
const zip = `${dir}/${built.zip}`
if (!fs.existsSync(zip)) fail(`the zip ${built.zip} is not beside its manifest`)
const bytes = fs.readFileSync(zip)
const sha = crypto.createHash("sha256").update(bytes).digest("hex")
if (sha !== built.sha256) fail("the zip is not the one release-app.sh made (its sha256 differs)")
const m = {
  v: 1, kid, version: built.version, git_sha: publicCommit, tag, min_app_version: min,
  zip_url: `https://github.com/${repo}/releases/download/${tag}/${built.zip}`, zip_name: built.zip, zip_sha256: sha,
  size: bytes.length, team_id: built.team_id, published_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
}
const u = JSON.parse(update)
if (u !== null) m.keys = u
const parsed = p.parseReleaseManifest(m)
if (!parsed.ok) fail(`the manifest does not check out: ${parsed.why}`)
fs.writeFileSync(`${dir}/latest.json.tmp`, p.releaseManifestJson(parsed.manifest))
'
# 2. After the key signed it: checked with the key's own public half and against the pinned list, then put in place.
CHECK_JS='
const [protoPath, dir, kid, pub, sig] = process.argv.slice(1)
const fs = await import("node:fs")
const p = await import(protoPath)
const fail = (why) => { process.stderr.write(`release-sign-manifest: ${why}\n`); process.exit(1) }
const json = fs.readFileSync(`${dir}/latest.json.tmp`)
const own = p.verifyReleaseManifest(json, sig, { keys: [{ kid, publicKey: pub }], retired: [] })
if (!own.ok) fail(`the signature does not verify with the public half of the key (${own.why})`)
if (p.RELEASE_KEYS.length > 0) {
  const pinned = p.verifyReleaseManifest(json, sig, { keys: [...p.RELEASE_KEYS], retired: [] })
  if (!pinned.ok) fail(`this key is not one the app pins (RELEASE_KEYS): ${pinned.why}`)
}
fs.writeFileSync(`${dir}/latest.json.sig.tmp`, `${sig}\n`)
fs.renameSync(`${dir}/latest.json.tmp`, `${dir}/latest.json`)
fs.renameSync(`${dir}/latest.json.sig.tmp`, `${dir}/latest.json.sig`)
process.stdout.write(`${own.manifest.version}\t${own.manifest.git_sha}\t${p.RELEASE_KEYS.length === 0 ? "unpinned" : "pinned"}\n`)
'
PROTO="$REPO_ROOT/packages/protocol/src/release-manifest.ts"
rm -f "$DIR/latest.json.tmp" "$DIR/latest.json.sig.tmp"
node --disable-warning=ExperimentalWarning --input-type=module -e "$BUILD_JS" "$PROTO" "${MANIFESTS[0]}" "$DIR" "$TAG" "$MIN" "$PUBLIC_REPO" \
  "$PUBLIC_COMMIT" "$KID" "$UPDATE_JSON" </dev/null || exit 1
SIG="$("${KEYTOOL[@]}" sign --key "$KEY_FILE" "$DIR/latest.json.tmp" "${SOFT[@]+"${SOFT[@]}"}")" || { rm -f "$DIR/latest.json.tmp"; die "the key did not sign"; }
OUT="$(node --disable-warning=ExperimentalWarning --input-type=module -e "$CHECK_JS" "$PROTO" "$DIR" "$KID" "$PUB" "$SIG" </dev/null)" \
  || { rm -f "$DIR/latest.json.tmp"; exit 1; }
IFS=$'\t' read -r VERSION SHA PIN <<<"$OUT"
echo "release-sign-manifest: wrote $DIR/latest.json and latest.json.sig for $VERSION ($SHA, tag $TAG)"
if [ "$PIN" = unpinned ]; then
  echo "release-sign-manifest: WARNING: the app pins no release key yet (RELEASE_KEYS is the placeholder); no app will install this release" >&2
fi
