#!/usr/bin/env bash
# go-public.sh -- the gate before a repo becomes public. Read-only unless you pass --yes-i-reviewed.
#
#   go-public.sh [--account NAME] check   [PATH]               account check + secret/privacy scan (DEFAULT, read-only)
#   go-public.sh [--account NAME] account                      only the account check
#   go-public.sh scan    [PATH]                                only the scan
#   go-public.sh [--account NAME] plan    PATH NAME            print the recreate plan (nothing runs)
#   go-public.sh [--account NAME] recreate PATH NAME --yes-i-reviewed [--tag vX.Y.Z]
#                                                              fresh single-commit PRIVATE repo, tagged (default v0.1.0)
#   go-public.sh [--account NAME] publish OWNER/NAME --yes-i-reviewed
#                                                              flip a PRIVATE repo to public (the only call that does)
#   go-public.sh verify  OWNER/NAME                            logged-out curl of the public URL
#
# Which GitHub account: the active `gh` login (gh api user -q .login) must equal the account you named, from
#   --account NAME, else $TALOS_GITHUB_ACCOUNT, else the first line of ${XDG_CONFIG_HOME:-~/.config}/talos/github-account.
# Nothing configured, or a mismatch, means refuse. This script never changes which gh account is active.
#
# The scan uses the same patterns as scripts/test-privacy.sh (keys, tokens, personal emails, home-folder paths, long
# ids), plus a private denylist you keep OUTSIDE the repo: TALOS_PRIVACY_DENYLIST=/path/file (one term per line).
# It covers the working tree AND every commit, and prints file:line (or commit:file) plus the finding type, never a value.
# A clean scan is not proof of a clean repo: the content read in the skill is still required.
set -uo pipefail

die() { echo "go-public: $*" >&2; exit 2; }
ACCOUNT_FLAG=""; CONFIRM=0; TAG="v0.1.0"; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --account) ACCOUNT_FLAG="${2:-}"; [ -n "$ACCOUNT_FLAG" ] || die "--account needs a name"; shift 2;;
    --account=*) ACCOUNT_FLAG="${1#*=}"; shift;;
    --yes-i-reviewed) CONFIRM=1; shift;;
    --check) ARGS+=("check"); shift;;
    --tag) TAG="${2:-}"; [ -n "$TAG" ] || die "--tag needs a value"; shift 2;;
    -h|--help) sed -n 2,24p "$0"; exit 0;;
    *) ARGS+=("$1"); shift;;
  esac
done
CMD="${ARGS[0]:-check}"
A1="${ARGS[1]:-}"; A2="${ARGS[2]:-}"
WANT=""; HAVE=""

configured_account() {
  local a="${ACCOUNT_FLAG:-${TALOS_GITHUB_ACCOUNT:-}}" f
  if [ -z "$a" ]; then
    f="${XDG_CONFIG_HOME:-$HOME/.config}/talos/github-account"
    [ -f "$f" ] && a=$(head -n 1 "$f" | tr -d '[:space:]')
  fi
  printf '%s' "$a"
}

# 0 = ok, 1 = not ok (message on stderr). Sets WANT and HAVE.
account_check() {
  WANT=$(configured_account)
  if [ -z "$WANT" ]; then
    cat >&2 <<MSG
go-public: no GitHub account is configured, so I will not guess which one to publish under.
  Name it once:  mkdir -p "\${XDG_CONFIG_HOME:-\$HOME/.config}/talos" && echo YOUR-HANDLE > "\${XDG_CONFIG_HOME:-\$HOME/.config}/talos/github-account"
  or set TALOS_GITHUB_ACCOUNT, or pass --account YOUR-HANDLE.
MSG
    return 1
  fi
  command -v gh >/dev/null 2>&1 || { echo "go-public: gh (GitHub CLI) is not installed or not on PATH" >&2; return 1; }
  HAVE=$(gh api user -q .login 2>/dev/null | head -n 1 | tr -d '[:space:]')
  if [ -z "$HAVE" ]; then
    echo "go-public: could not read the active gh login (gh api user failed). Check 'gh auth status'. Not changing anything." >&2
    return 1
  fi
  if [ "$(printf '%s' "$HAVE" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$WANT" | tr 'A-Z' 'a-z')" ]; then
    echo "go-public: MISMATCH. Active gh account is '$HAVE', configured publish account is '$WANT'." >&2
    echo "  I will not switch accounts for you (it is machine-wide and changes git auth in every repo). Switch it yourself, or fix the config." >&2
    return 1
  fi
  echo "OK: active gh account is $HAVE (matches the configured account)"
  return 0
}

cmd_scan() {
  local p="${1:-.}"
  [ -d "$p" ] || die "scan needs a directory"
  p=$(cd "$p" && pwd)
  SCAN_ROOT="$p" python3 - <<'PY'
import os, re, subprocess, sys
root = os.environ["SCAN_ROOT"]
SECRETS = [  # same patterns as scripts/test-privacy.sh
    ("an sk- API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("an sk_ API key", re.compile(r"\bsk_[A-Za-z0-9]{20,}")),
    ("a GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("a Slack token", re.compile(r"\bxox[bpas]-[A-Za-z0-9-]{10,}")),
    ("an AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("a PEM private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("a Telegram bot token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{35}\b")),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}")
OK_DOM = ("example.com", "example.org", "acme.com", "noreply.anthropic.com", "users.noreply.github.com")
USERPATH = re.compile(r"/(?:Users|home)/(?!\w*(?:you|user|name|me|someone|agent)\b)[A-Za-z0-9._-]{2,}/")
LONGNUM = re.compile(r"(?<![\w.:/-])\d{9,}(?![\w.-])")
RISKY = re.compile(r"\.(env|pem|key|p12|pfx|sqlite3?|db|csv|xlsx?|tsv|parquet|sql|dump)$|(^|/)\.env(\.|$)|credentials|secrets?\.(json|ya?ml)", re.I)
SAFE_ENV = re.compile(r"\.env\.(example|sample|template)$")

deny = []
dl = os.environ.get("TALOS_PRIVACY_DENYLIST")
if dl:
    dl = os.path.expanduser(dl)
    if os.path.realpath(dl).startswith(os.path.realpath(root) + os.sep):
        print("  FAIL the denylist is INSIDE the repo being scanned; it is private and must live outside it"); sys.exit(3)
    try:
        deny = [l.strip().lower() for l in open(dl, encoding="utf-8") if l.strip() and not l.startswith("#")]
    except OSError as e:
        print("  FAIL cannot read TALOS_PRIVACY_DENYLIST: %s" % e); sys.exit(3)

def kinds(line):
    out = []
    for what, rx in SECRETS:
        if rx.search(line): out.append(what)
    for m in EMAIL.finditer(line):
        dom = m.group(0).split("@", 1)[1].lower()
        if not dom.endswith(OK_DOM) and dom not in ("t.t", "local"):
            out.append("an email address")
    if USERPATH.search(line): out.append("an absolute home-folder path")
    for m in LONGNUM.finditer(line):
        s = m.group(0)
        if set(s) == {"0"} or s in ("123456789", "1234567890", "987654321"): continue
        out.append("a long bare number (chat or account id?)")
    low = line.lower()
    for i, t in enumerate(deny):
        if t in low: out.append("a denylist term (entry #%d)" % (i + 1))   # the term itself is private: never echoed
    return sorted(set(out))

def git(*a):
    return subprocess.run(["git", "-C", root] + list(a), capture_output=True, text=True, errors="replace")

is_git = os.path.isdir(os.path.join(root, ".git"))
if is_git:
    files = [f for f in git("ls-files", "-co", "--exclude-standard", "-z").stdout.split("\0") if f]
else:
    files = []
    for d, ds, fs in os.walk(root):
        ds[:] = [x for x in ds if x not in (".git", "node_modules", "__pycache__")]
        files += [os.path.relpath(os.path.join(d, f), root) for f in fs]
hits = []
print("== go-public scan: %s" % root)
print("-- working tree (%d files)" % len(files))
for rel in files:
    if RISKY.search(rel) and not SAFE_ENV.search(rel):
        hits.append("  [risky file] %s  (data or credential file type: confirm it is meant to ship)" % rel)
    try:
        data = open(os.path.join(root, rel), "rb").read()
    except OSError:
        continue
    if b"\0" in data[:4096]:
        continue
    for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
        for k in kinds(line):
            hits.append("  [tree] %s:%d  %s" % (rel, n, k))
print("-- every commit, added lines" if is_git else "-- (not a git repo: history scan skipped; git init it first so the recreate has something to copy)")
if is_git:
    p = subprocess.Popen(["git", "-C", root, "log", "--all", "-p", "-U0", "--no-color", "--format=%x00%H"],
                         stdout=subprocess.PIPE, text=True, errors="replace")
    commit = fname = ""; seen = set()
    for line in p.stdout:
        if line.startswith("\0"):
            commit = line[1:].strip()[:8]; fname = ""; continue
        if line.startswith("+++ b/"):
            fname = line[6:].strip(); continue
        if line.startswith("+") and not line.startswith("+++"):
            for k in kinds(line[1:]):
                key = (commit, fname, k)
                if key not in seen:
                    seen.add(key); hits.append("  [history] %s:%s  %s" % (commit, fname, k))
    p.wait()
    refs = git("for-each-ref", "--format=%(refname)").stdout.split()
    extra = [r for r in refs if r.startswith(("refs/pull/", "refs/remotes/"))]
    if extra:
        print("-- note: %d pull/remote refs keep old commits; a recreate leaves them behind, flipping this repo would not" % len(extra))
gl = subprocess.run(["sh", "-c", "command -v gitleaks"], capture_output=True, text=True).stdout.strip()
print("-- gitleaks: %s" % ("installed; run it yourself with --redact=100 as a second opinion" if gl else "not installed (optional second opinion)"))
seen = set(); uniq = [h for h in hits if not (h in seen or seen.add(h))]
for h in uniq[:200]:
    print(h)
if len(uniq) > 200: print("  ... %d more" % (len(uniq) - 200))
print("== Hits are leads, not verdicts. No values are printed. Employer, customer, personal and family content must still be READ by a person.")
if uniq:
    print("RESULT: FINDINGS (%d). Do not go public until each is fixed or waived by you in words." % len(uniq)); sys.exit(1)
print("RESULT: no automated findings in the tree and history (still do the content read)"); sys.exit(0)
PY
}

cmd_check() {
  local rc=0
  account_check || rc=1
  cmd_scan "${A1:-.}" || rc=1
  if [ $rc -eq 0 ]; then echo "CHECK PASSED (read-only: nothing was created, pushed or changed)"
  else echo "CHECK FAILED (read-only: nothing was created, pushed or changed)"; fi
  return $rc
}

cmd_plan_or_recreate() {
  local src="$A1" name="$A2"
  { [ -d "$src" ] && [ -n "$name" ]; } || die "usage: recreate PATH NEW-REPO-NAME [--yes-i-reviewed]"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "bad repo name"
  src=$(cd "$src" && pwd)
  local work="${TMPDIR:-/tmp}/go-public-$name" n owner
  owner=$(configured_account); owner="${owner:-<account not configured>}"
  n=$(git -C "$src" ls-files -co --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
  cat <<PLAN
== recreate plan (never rewrite or flip the old repo in place: its refs/pull/* and commit URLs stay reachable)
 1. account check:   must equal the configured account ($owner)
 2. scan source:     $src  (must be clean, or each finding waived by you in words)
 3. fresh dir:       $work  (must not exist yet)
 4. copy:            $n tracked or untracked-not-ignored files; no .git, no ignored files
 5. README.md and a LICENSE file must already be in the tree (write them first; the script will not invent them)
 6. one commit:      git init -b main; git add -A; git commit -m "Initial release"
                     commit author will be: $(git config user.name 2>/dev/null) <$(git config user.email 2>/dev/null)>  (PUBLIC once the repo is public)
 7. create PRIVATE:  gh repo create $owner/$name --private --source $work --push
 8. tag:             git tag $TAG; git push origin $TAG
 9. STOP. Making it public is a separate command: go-public.sh publish $owner/$name --yes-i-reviewed
PLAN
  if [ "$CMD" = "plan" ] || [ $CONFIRM -ne 1 ]; then
    echo "(read-only: nothing executed. recreate needs --yes-i-reviewed after you have read the scan report)"
    return 0
  fi
  account_check || return 1
  cmd_scan "$src" || { echo "go-public: refusing, the scan has findings." >&2; return 1; }
  if [ ! -f "$src/README.md" ] || ! ls "$src" | grep -qi '^licen[sc]e'; then
    echo "go-public: refusing, README.md and a LICENSE file must exist in $src first." >&2; return 1
  fi
  [ -e "$work" ] && die "$work already exists"
  mkdir -p "$work" || die "cannot create $work"
  git -C "$src" ls-files -co --exclude-standard -z \
    | (cd "$src" && xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "$2")" && cp -p "$2" "$1/$2"' _ "$work" {}) || die "copy failed"
  git -C "$work" init -q -b main && git -C "$work" add -A && git -C "$work" commit -q -m "Initial release" || die "commit failed"
  cmd_scan "$work" >/dev/null || { echo "go-public: refusing, the fresh copy fails the scan (see: go-public.sh scan $work)." >&2; return 1; }
  gh repo create "$WANT/$name" --private --source "$work" --push || die "gh repo create failed"
  git -C "$work" tag "$TAG" && git -C "$work" push origin "$TAG" || die "tag push failed"
  echo "Created PRIVATE $WANT/$name from $work and tagged $TAG. Review it on GitHub, then publish."
}

cmd_publish() {
  local r="$A1"
  [[ "$r" == */* ]] || die "usage: publish OWNER/NAME --yes-i-reviewed"
  if [ $CONFIRM -ne 1 ]; then
    echo "go-public: publish is read-only without --yes-i-reviewed. It would run: gh repo edit $r --visibility public --accept-visibility-change-consequences"
    return 0
  fi
  account_check || return 1
  [ "$(printf '%s' "${r%%/*}" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$WANT" | tr 'A-Z' 'a-z')" ] \
    || { echo "go-public: $r is not under the configured account $WANT; refusing." >&2; return 1; }
  [ "$(gh repo view "$r" --json isPrivate -q .isPrivate 2>/dev/null)" = "true" ] \
    || { echo "go-public: $r is not a private repo I can see; refusing." >&2; return 1; }
  gh repo edit "$r" --visibility public --accept-visibility-change-consequences || die "gh repo edit failed"
  echo "$r is now public. Run: go-public.sh verify $r"
}

cmd_verify() {
  local r="$A1"
  [[ "$r" == */* ]] || die "usage: verify OWNER/NAME"
  local web api
  web=$(env -u GH_TOKEN -u GITHUB_TOKEN curl -s -o /dev/null -w '%{http_code}' "https://github.com/$r")
  api=$(env -u GH_TOKEN -u GITHUB_TOKEN curl -s "https://api.github.com/repos/$r" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin); print(d["private"] if "private" in d else "notfound")
except Exception:
    print("err")')
  echo "logged-out https://github.com/$r -> HTTP $web ; api private=$api"
  if [ "$web" = "200" ] && [ "$api" = "False" ]; then echo "OK: publicly reachable without any credentials"; return 0; fi
  echo "NOT public (or unreachable) when logged out"; return 1
}

case "$CMD" in
  check) cmd_check;;
  account) account_check;;
  scan) cmd_scan "${A1:-.}";;
  plan|recreate) cmd_plan_or_recreate;;
  publish) cmd_publish;;
  verify) cmd_verify;;
  *) sed -n 2,24p "$0"; exit 2;;
esac
