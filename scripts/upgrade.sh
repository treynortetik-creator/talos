#!/usr/bin/env bash
# upgrade.sh -- move a running agent onto a new kit without losing what it remembers.
#
#   bash "<new kit>/scripts/upgrade.sh" --into "<your agent folder>" --dry-run
#   bash "<new kit>/scripts/upgrade.sh" --into "<your agent folder>"
#   bash "<new kit>/scripts/upgrade.sh" --explain wiki/me.md memory/STATE.md
#   bash "<new kit>/scripts/upgrade.sh" --rollback "<backup folder>" --into "<agent folder>"
#
# It is always run FROM THE NEW KIT, never from the folder being upgraded. That is
# not a style choice: an agent installed before this script existed has no
# scripts/upgrade.sh to run, and that describes every install to date.
#
# WHAT IT DOES, and the two failures it exists to prevent:
#
#   A first install copies the kit in without overwriting anything of the user's
#   (install.sh uses a tar pipe into an empty folder; the by-hand fallback is `cp -n`,
#   which "refuses to overwrite a file of theirs that has the same name as a kit file").
#   Right for a first install.
#   For an upgrade it means the user keeps every old hook and script, receives none
#   of the fixes, and is told it worked. A silent no-op.
#
#   The opposite reflex -- point an agent at the new kit and say "figure it out" --
#   overwrites memory/ and wiki/ and destroys months of accumulated context.
#
#   So neither: .upgradeignore names the user's data, everything else is code and
#   is replaced wholesale, and this script is the only thing that reads that file.
#
# THREE GUARANTEES, in order of how much they matter:
#
#   1. IT NEVER DELETES ANYTHING. Not one path. It adds files and it overwrites
#      files, and that is the complete list of what it does to a disk. That is why
#      .upgradeignore only has to name paths where a kit file and a user file
#      actually collide -- nothing this script does can reach anything else.
#   2. NOTHING MATCHED BY .upgradeignore IS WRITTEN. Checked twice: once when the
#      plan is built, and again against the real bytes on disk afterwards, by code
#      that does not share a line with the first check. A protected file that moved
#      is a failed upgrade, not a warning.
#   3. THERE IS A FULL BACKUP BEFORE THE FIRST BYTE IS WRITTEN. No flag turns it
#      off. It carries a receipt, and --rollback undoes the upgrade from it.
#
# THE GATE: scripts/self-test.sh, run in the upgraded folder, all checks green.
# Anything less and the correct move is --rollback. verify-install.sh is run too,
# but only as a report: it grades the USER'S setup, which can be legitimately
# incomplete (an interrupted interview) without the new code being wrong.

set -u

SRC="$(cd "$(dirname "$0")/.." && pwd)" || { echo "cannot resolve the kit this script lives in" >&2; exit 2; }
DST=""; MODE="apply"; BACKUP_DIR=""; ROLLBACK_FROM=""; RUN_GATE=1
EXPLAIN_PATHS=""

red()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --into)       DST="${2:-}"; [ -n "$DST" ] || { red "--into needs a path"; exit 2; }; shift 2 ;;
    --dry-run)    MODE="plan"; shift ;;
    --explain)    MODE="explain"; shift
                  while [ $# -gt 0 ]; do case "$1" in --*) break;; *) EXPLAIN_PATHS="$EXPLAIN_PATHS$1
";; esac; shift; done ;;
    --rollback)   ROLLBACK_FROM="${2:-}"; [ -n "$ROLLBACK_FROM" ] || { red "--rollback needs the backup folder"; exit 2; }
                  MODE="rollback"; shift 2 ;;
    --backup-dir) BACKUP_DIR="${2:-}"; [ -n "$BACKUP_DIR" ] || { red "--backup-dir needs a path"; exit 2; }; shift 2 ;;
    # For the kit's own suite only. UPGRADE.md never uses it, and a run that skips the
    # gate says so in red on its last line -- an unproven upgrade must not read as a clean one.
    --no-gate)    RUN_GATE=0; shift ;;
    -h|--help)    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            red "unknown argument: $1"; exit 2 ;;
  esac
done

UPIGNORE="$SRC/.upgradeignore"
[ -f "$UPIGNORE" ] || { red "missing $UPIGNORE"
  red "That file is the boundary between the kit's code and the user's data. Without it this"
  red "script would have to guess which of someone's files are safe to destroy. It will not guess."
  exit 2; }

# ---------------------------------------------------------------------------
# The matcher. One implementation, used by the plan, the verification pass and
# --explain, so the three can never disagree about what "protected" means.
# ---------------------------------------------------------------------------
MATCHER=$(cat <<'PYEOF'
import sys, fnmatch

def load(path):
    pats = []
    with open(path, encoding='utf-8') as fh:
        for raw in fh:
            line = raw.rstrip('\n').rstrip()
            if not line or line.lstrip().startswith('#'):
                continue
            neg = line.startswith('!')
            if neg:
                line = line[1:]
            isdir = line.endswith('/')
            lead = line.startswith('/')          # a leading slash anchors the pattern to the folder root (gitignore rule)
            line = line.rstrip('/').lstrip('/')
            if line:
                pats.append((line, neg, isdir, lead or '/' in line))
    return pats

def hit(rel, pat, isdir, anchored):
    segs = rel.split('/')
    if anchored:
        if isdir:
            # fnmatch's `*` also crosses `/`, so `.claude/skills/talos-*/` covers everything inside such a folder
            return rel == pat or rel.startswith(pat + '/') or fnmatch.fnmatch(rel, pat + '/*')
        return rel == pat or fnmatch.fnmatch(rel, pat) or rel.startswith(pat + '/')
    if isdir:
        # a directory name with no slash matches that directory at ANY depth
        return any(fnmatch.fnmatch(s, pat) for s in segs[:-1])
    # a bare name matches that basename at any depth
    return fnmatch.fnmatch(segs[-1], pat)

def verdict(rel, pats):
    """Returns (protected: bool, reason: str). LAST matching pattern wins, which is
    what lets a `!` line carve code back out of a protected directory."""
    out = (False, 'no pattern')
    for pat, neg, isdir, anchored in pats:
        if hit(rel, pat, isdir, anchored):
            out = (not neg, ('!' if neg else '') + pat + ('/' if isdir else ''))
    return out
PYEOF
)

# ---------------------------------------------------------------------------
# --explain: ask the boundary a direct question. No source or target needed.
# ---------------------------------------------------------------------------
if [ "$MODE" = explain ]; then
  [ -n "$EXPLAIN_PATHS" ] || { red "--explain needs at least one path"; exit 2; }
  printf '%s' "$EXPLAIN_PATHS" | python3 -c "
$MATCHER
import sys
pats = load(sys.argv[1])
rc = 0
for line in sys.stdin.read().splitlines():
    # Strip a './' prefix, NEVER bare leading dots -- lstrip('./') would turn '.env' into
    # 'env' and '.claude/x' into 'claude/x', and this command would then confidently give
    # the right answer for the wrong path. Caught 2026-09-04.
    rel = line.strip()
    while rel.startswith('./'):
        rel = rel[2:]
    if not rel:
        continue
    prot, why = verdict(rel, pats)
    print(('PROTECT  %-44s  matched: %s' if prot else 'CODE     %-44s  matched: %s') % (rel, why))
sys.exit(rc)
" "$UPIGNORE"
  exit $?
fi

# ---------------------------------------------------------------------------
# Target resolution, and the ways this can be pointed at the wrong folder.
# ---------------------------------------------------------------------------
[ -n "$DST" ] || DST="$PWD"
DST="$(cd "$DST" 2>/dev/null && pwd)" || { red "--into: no such directory"; exit 2; }

[ "$SRC" != "$DST" ] && : || { red "the new kit and the folder to upgrade are the same directory"
  red "  $SRC"
  red "Extract the new kit somewhere else first. Upgrading a folder from itself is a no-op that"
  red "reports success, which is the exact failure this script was written to end."
  exit 2; }
case "$DST/" in "$SRC"/*) red "the target is inside the new kit ($DST). Point --into at your agent folder."; exit 2;; esac
case "$SRC/" in "$DST"/*) red "the new kit is inside the target folder. Extract it somewhere else -- otherwise the backup would contain the kit and the plan would walk itself."; exit 2;; esac

# ---------------------------------------------------------------------------
# --rollback: put the backup back. Surgical, using the receipt, so files the user
# created AFTER the upgrade are not collateral.
# ---------------------------------------------------------------------------
if [ "$MODE" = rollback ]; then
  B="$(cd "$ROLLBACK_FROM" 2>/dev/null && pwd)" || { red "--rollback: no such directory: $ROLLBACK_FROM"; exit 2; }
  R="$B/_upgrade-receipt.txt"
  [ -f "$R" ] || { red "no _upgrade-receipt.txt in $B -- that is not a backup this script made"; exit 2; }
  [ -d "$B/tree" ] || { red "no tree/ in $B -- the backup is incomplete; do not trust it"; exit 2; }
  hdr "ROLLBACK"
  echo "  from: $B"
  echo "  into: $DST"
  n_restored=0; n_removed=0
  while IFS='	' read -r verb rel; do
    case "$verb" in
      UPDATED) [ -f "$B/tree/$rel" ] && { mkdir -p "$DST/$(dirname "$rel")"; cp -p "$B/tree/$rel" "$DST/$rel" && n_restored=$((n_restored+1)); } ;;
      NEW)     [ -f "$DST/$rel" ] && { rm -f "$DST/$rel" && n_removed=$((n_removed+1)); } ;;
    esac
  done < "$R"
  # The stamp goes back to what it was, including "there was no stamp".
  if [ -f "$B/tree/.talos-version" ]; then cp -p "$B/tree/.talos-version" "$DST/.talos-version"
  else rm -f "$DST/.talos-version"; fi
  grn "restored $n_restored file(s), removed $n_removed file(s) the upgrade had added"
  echo "Your data was never touched by the upgrade, so there is nothing to restore there."
  echo "The full pre-upgrade copy is still at $B/tree -- delete it when you are satisfied."
  exit 0
fi

# ---------------------------------------------------------------------------
# Is the source a kit, and is the target an install?
# ---------------------------------------------------------------------------
for f in BOOTSTRAP.md scripts/self-test.sh scripts/verify-install.sh hooks/session-start.py; do
  [ -e "$SRC/$f" ] || { red "$SRC does not look like a Talos kit (no $f). Point this at the folder you cloned the new kit into."; exit 2; }
done
_looks_installed=0
for f in CLAUDE.md hooks/session-start.py wiki/_index.md; do
  [ -e "$DST/$f" ] && _looks_installed=1
done
[ "$_looks_installed" = 1 ] || { red "$DST does not look like a Talos agent folder (no CLAUDE.md, no hooks/, no wiki/)."
  red "For a brand new agent you want BOOTSTRAP.md, not this script."; exit 2; }

# ---------------------------------------------------------------------------
# Versions. The unstamped case is not an edge case: every install made before
# 1.0.0 has no .talos-version, including the first one anybody else ran.
# ---------------------------------------------------------------------------
_field() { # <file> <key>  -- tolerant of key=value and key: value
  [ -f "$1" ] || return 0
  sed -n -E "s/^[[:space:]]*$2[[:space:]]*[=:][[:space:]]*//p" "$1" | head -1 | tr -d '"\r'
}
NEW_VERSION="$(_field "$SRC/.talos-release" version)"
[ -n "$NEW_VERSION" ] && : || NEW_VERSION="$(tr -d ' \t\r\n' < "$SRC/VERSION" 2>/dev/null)"
[ -n "$NEW_VERSION" ] && : || NEW_VERSION="unknown"
NEW_KIND="$(_field "$SRC/.talos-release" kind)"
if [ -z "$NEW_KIND" ]; then
  if [ -e "$SRC/.git" ]; then NEW_KIND="git-checkout"; else NEW_KIND="unstamped-source"; fi
fi
NEW_COMMIT="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || true)"
NEW_SHA="$(_field "$SRC/.talos-release" content_sha256)"
OLD_VERSION="$(_field "$DST/.talos-version" version)"
OLD_INSTALLED="$(_field "$DST/.talos-version" installed)"
if [ -z "$OLD_VERSION" ]; then
  OLD_VERSION="unstamped"
  OLD_DESC="unstamped -- this install predates version stamping (pre-1.0.0). That is expected, not a fault."
else
  OLD_DESC="$OLD_VERSION"
fi

hdr "TALOS UPGRADE"
echo "  new kit:  $SRC"
echo "            version $NEW_VERSION  (bundle kind: $NEW_KIND)"
echo "  agent:    $DST"
echo "            version $OLD_DESC"
echo "  boundary: $UPIGNORE"

# ---------------------------------------------------------------------------
# THE PLAN. Every file in the new kit is classified against .upgradeignore, then
# against what is already on disk.
# ---------------------------------------------------------------------------
#
# A source with no .talos-release is a plain git checkout. If it carries a .releaseignore (an older
# maintainer's working tree did), apply it on the way in so nothing internal is ever copied. Skipped files are not "protected" (they are
# not the user's), they are simply not part of the kit.
RELIGNORE=""
if [ ! -f "$SRC/.talos-release" ] && [ -f "$SRC/.releaseignore" ]; then
  RELIGNORE="$SRC/.releaseignore"
  echo "  source:   unstamped working tree -- .releaseignore applied to it as well"
fi

PLAN="$(mktemp)" || exit 2
trap 'rm -f "$PLAN"' EXIT
python3 - "$UPIGNORE" "$SRC" "$DST" "$RELIGNORE" > "$PLAN" <<PYEOF
$MATCHER
import os, sys, hashlib
up, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
rel_ignore = sys.argv[4] if len(sys.argv) > 4 else ''
pats = load(up)
relpats = load(rel_ignore) if rel_ignore else []

def digest(p):
    h = hashlib.sha256()
    with open(p, 'rb') as fh:
        for chunk in iter(lambda: fh.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()

rows = []
for root, dirs, files in os.walk(src):
    rel_root = os.path.relpath(root, src)
    if rel_root == '.':
        rel_root = ''
    # .git is enormous and is never kit content; skip the walk, not just the copy
    dirs[:] = [d for d in dirs if not (rel_root == '' and d == '.git')]
    for name in files:
        # NOT lstrip('./') -- that strips leading dots too, turning '.claude/agents/x' into
        # 'claude/agents/x', which sails straight past the '.claude/' rule and lands the file
        # in a directory that does not exist. Caught 2026-09-04 by reading a dry-run plan.
        rel = (rel_root + '/' + name) if rel_root else name
        s = os.path.join(root, name)
        if relpats and verdict(rel, relpats)[0]:
            rows.append(('SKIPPED-NOT-KIT', rel, verdict(rel, relpats)[1]))
            continue
        prot, why = verdict(rel, pats)
        if prot:
            rows.append(('PROTECTED', rel, why))
            continue
        d = os.path.join(dst, rel)
        if not os.path.exists(d):
            rows.append(('NEW', rel, ''))
        elif digest(s) != digest(d):
            rows.append(('UPDATED', rel, ''))
        else:
            rows.append(('SAME', rel, ''))

# Files in the install that the new kit does not ship. Never deleted -- reported, so a
# human can decide. This is where a previous release's maintainer leak shows up.
src_files = set(r[1] for r in rows)
SKIPDIRS = ('.git', 'memory', 'wiki', '.learnings', '.agent-state', '.seed-staging',
            '.dive-staging', '.claude', 'personal', '__pycache__')
for root, dirs, files in os.walk(dst):
    rel_root = os.path.relpath(root, dst)
    rel_root = '' if rel_root == '.' else rel_root
    dirs[:] = [d for d in dirs if not (rel_root == '' and d in SKIPDIRS) and d != '__pycache__']
    for name in files:
        rel = (rel_root + '/' + name).lstrip('/') if rel_root else name
        if rel in src_files:
            continue
        prot, why = verdict(rel, pats)
        if not prot:
            rows.append(('ONLY-IN-INSTALL', rel, ''))

for kind, rel, why in sorted(rows):
    sys.stdout.write('%s\t%s\t%s\n' % (kind, rel, why))
PYEOF
[ -s "$PLAN" ] || { red "the plan came back empty -- refusing to continue"; exit 2; }

n_new=$(grep -c '^NEW	' "$PLAN"); n_upd=$(grep -c '^UPDATED	' "$PLAN")
n_same=$(grep -c '^SAME	' "$PLAN"); n_prot=$(grep -c '^PROTECTED	' "$PLAN")
n_only=$(grep -c '^ONLY-IN-INSTALL	' "$PLAN")
n_skip=$(grep -c '^SKIPPED-NOT-KIT	' "$PLAN")

# A source stamped kind=upgrade is expected to have had .upgradeignore applied already, so our
# matcher should find nothing protected inside it. When it does, note it -- but do NOT refuse.
#
# 2026-09-04: this WAS a hard refusal, and it broke a build that overlaid an upgrade stamp onto a
# full tree and self-tested the result: that tree holds every kit file AND carries kind=upgrade,
# so it trips a check whose premise ("stamped upgrade, therefore already filtered") is false for
# it. The same shape appears in any upgraded folder. Refusing bought nothing either: the protection is that these
# files are skipped and then re-verified byte-for-byte after the write, which happens anyway.
# A guard that blocks a valid case and guards nothing is worse than the warning it replaced.
if [ "$NEW_KIND" = upgrade ] && [ "$n_prot" -gt 0 ]; then
  printf '  note: bundle is stamped kind=upgrade yet %d of its files match .upgradeignore.\n' "$n_prot"
  printf '        Expected when an upgrade has been overlaid onto a full kit. They are skipped either way.\n'
fi

hdr "PLAN"
printf '  %4d new       (files this kit adds)\n' "$n_new"
printf '  %4d updated   (code that changes)\n'   "$n_upd"
printf '  %4d unchanged\n'                        "$n_same"
printf '  %4d protected (yours: never written)\n' "$n_prot"
printf '  %4d only in your folder (never deleted; listed below)\n' "$n_only"
[ "$n_skip" -gt 0 ] && printf '  %4d in the source but not shippable (.releaseignore; never copied)\n' "$n_skip"

if [ "$n_new" -gt 0 ]; then hdr "NEW"; grep '^NEW	' "$PLAN" | cut -f2 | sed 's/^/  + /'; fi
if [ "$n_upd" -gt 0 ]; then hdr "UPDATED"; grep '^UPDATED	' "$PLAN" | cut -f2 | sed 's/^/  ~ /'; fi
if [ "$n_only" -gt 0 ]; then
  hdr "ONLY IN YOUR FOLDER -- not touched, not deleted, read this list"
  echo "  Files the new kit does not ship. Yours to keep are fine. Anything here that came"
  echo "  from an OLD kit is now stale (an old release shipped maintainer notes by mistake)."
  grep '^ONLY-IN-INSTALL	' "$PLAN" | cut -f2 | sed 's/^/  ? /'
fi

# --- protected files that differ from the kit's copy: the merge list -------------------
hdr "PROTECTED -- yours, kept as they are"
echo "  $n_prot files matched .upgradeignore. These are never written. Of them, the ones"
echo "  where the kit's own copy has changed are worth a look by hand:"
_merge=0
while IFS='	' read -r kind rel why; do
  [ "$kind" = PROTECTED ] || continue
  [ -f "$DST/$rel" ] || continue
  cmp -s "$SRC/$rel" "$DST/$rel" 2>/dev/null && continue
  printf '  ! %-46s (kept; kit version differs)  [%s]\n' "$rel" "$why"
  _merge=$((_merge+1))
done < "$PLAN"
[ "$_merge" = 0 ] && echo "  (none differ -- nothing to merge by hand)"

# --- the hook reconciliation, which is the one .upgradeignore cannot do for you --------
# .claude/settings.json is protected because it holds permission grants a user cannot
# reconstruct. The cost of protecting it is that a NEW hook can ship and never be
# registered -- the silent no-op, back again by another door. So diff it explicitly.
hdr "HOOKS TO RECONCILE"
python3 - "$SRC/templates/dot-claude/settings.json" "$DST/.claude/settings.json" "$SRC" "$DST" <<'PY'
import json, re, sys, os
tmpl_p, live_p, src_root, dst_root = sys.argv[1:5]
if not os.path.exists(tmpl_p):
    print("  the new kit ships no settings template -- nothing to compare"); raise SystemExit
if not os.path.exists(live_p):
    print("  \033[31m.claude/settings.json is MISSING from your folder.\033[0m Copy it:")
    print("    cp templates/dot-claude/settings.json .claude/settings.json"); raise SystemExit
try:
    tmpl, live = json.load(open(tmpl_p)), json.load(open(live_p))
except Exception as e:
    print("  could not parse one of them (%s) -- reconcile by hand" % e); raise SystemExit

# Every hook command that runs a script from this folder's hooks/ directory, whatever its name. This used to
# hard-code two script names, so every hook added after them could ship and never be registered.
SCRIPT = re.compile(r'hooks/([A-Za-z0-9_.-]+\.(?:py|sh))')
# Any script path a command runs, project-relative or absolute (Chronos's hook is absolute).
ANYPATH = re.compile(r'(\$CLAUDE_PROJECT_DIR/[^"\'\s;]*\.(?:py|sh)|/[^"\'\s;$]*\.(?:py|sh))')

def commands(d):
    out = {}
    for event, entries in (d.get("hooks") or {}).items():
        for e in entries or []:
            for h in e.get("hooks", []):
                c = h.get("command", "")
                m = SCRIPT.search(c)
                if m and "$CLAUDE_PROJECT_DIR" in c:
                    out.setdefault(event + ":" + m.group(1), (e.get("matcher"), c))
    return out

t, l = commands(tmpl), commands(live)
missing = [k for k in t if k not in l]
if missing:
    print("  \033[31mThe new kit registers hooks your settings.json does not:\033[0m")
    for k in missing:
        ev, script = k.split(":", 1)
        print("    - %s on %s%s" % (script, ev, (" (matcher %s)" % t[k][0]) if t[k][0] else ""))
    print("  Your file is PROTECTED on purpose (it holds your permission grants), so this")
    print("  script will not edit it. MERGE the hooks block from")
    print("    %s" % tmpl_p)
    print("  into %s by hand, keeping your permissions. Then re-run verify-install.sh." % live_p)
else:
    print("  every hook the new kit registers is already registered in your settings.json")
# matcher drift: registered, but on a narrower event set than the kit now ships
for k in t:
    if k in l and (t[k][0] or "") != (l[k][0] or ""):
        print("  ! %s matcher differs: kit '%s' vs yours '%s'" % (k, t[k][0], l[k][0]))

# FAIL-CLOSED WRAPPER (1.1.2): the four safety guards' commands now block an unattended (Chronos) run when the script is
# missing or crashes. A settings.json written by an older kit has the old wrapper: it works, but a missing or crashing guard
# is silently skipped in a scheduled run. Report each guard whose registered command lacks the new wrapper.
for k in t:
    ev, script = k.split(":", 1)
    if ev == "PreToolUse" and "TALOS_UNATTENDED" in t[k][1] and k in l and "TALOS_UNATTENDED" not in l[k][1]:
        print("  ! %s on PreToolUse still has the pre-1.1.2 fail-open wrapper: copy its command from the kit's template" % script)
        print("    so that a missing or crashing guard BLOCKS an unattended scheduled run (it is harmless in a live session).")

# STALE: a registered command whose script does not exist (and will not after this upgrade). Without the
# fail-open wrapper, python3 exits 2 on a missing file and a UserPromptSubmit/PreToolUse hook then BLOCKS every
# prompt or every Bash call. The classic case is an old hooks/job-inbox.py registration after the file went.
stale = []
for event, entries in (live.get("hooks") or {}).items():
    for e in entries or []:
        for h in e.get("hooks", []):
            c = h.get("command", "")
            for m in ANYPATH.finditer(c):
                p = m.group(1)
                if p.startswith("$CLAUDE_PROJECT_DIR"):
                    rel = p[len("$CLAUDE_PROJECT_DIR"):].lstrip("/")
                    if not (os.path.exists(os.path.join(dst_root, rel)) or os.path.exists(os.path.join(src_root, rel))):
                        stale.append((event, rel))
                elif not os.path.exists(p):
                    stale.append((event, p))
if stale:
    print("  \033[31mSTALE hook registrations (the script does not exist):\033[0m")
    for ev, p in stale:
        print("    - STALE %s on %s" % (p, ev))
    print("  Remove each of those entries from %s. A command that is not wrapped to fail open" % live_p)
    print("  can block every prompt or every Bash call once its script is gone.")
PY

if [ "$MODE" = plan ]; then
  hdr "DRY RUN -- nothing was written."
  echo "Re-run without --dry-run to apply. A full backup is taken first, automatically."
  exit 0
fi

# ---------------------------------------------------------------------------
# BACKUP. Before the first byte. No flag disables this.
# ---------------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"

# The git snapshot goes FIRST, before the copy, and the ordering is load-bearing rather than
# stylistic. Committing after the backup mutates .git/index and .git/logs/ in the target but
# not in the backup, and .git/ is protected -- so the post-write check would compare the two,
# find five modified files, and report the script's own snapshot as a boundary violation.
# It did exactly that on 2026-09-04. Snapshot, then copy, and the two agree by construction.
if git -C "$DST" rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git -C "$DST" status --porcelain 2>/dev/null)" ]; then
    git -C "$DST" add -- memory wiki .learnings .claude CLAUDE.md hooks scripts templates >/dev/null 2>&1
    git -C "$DST" -c user.email=talos@local -c user.name=talos commit -qm "pre-upgrade snapshot ($OLD_VERSION -> $NEW_VERSION)" >/dev/null 2>&1 \
      && echo "  git: committed a pre-upgrade snapshot"
  else
    echo "  git: working tree already clean ($(git -C "$DST" rev-parse --short HEAD 2>/dev/null))"
  fi
fi

if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR="$(dirname "$DST")/$(basename "$DST")-backup-$STAMP"
fi
[ -e "$BACKUP_DIR" ] && { red "backup path already exists: $BACKUP_DIR"; exit 2; }
mkdir -p "$BACKUP_DIR/tree" || { red "cannot create the backup at $BACKUP_DIR -- refusing to write anything"; exit 2; }
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$DST/" "$BACKUP_DIR/tree/" || { red "backup failed -- nothing was written to your folder"; exit 2; }
else
  cp -R "$DST/." "$BACKUP_DIR/tree/" || { red "backup failed -- nothing was written to your folder"; exit 2; }
fi
# Prove it, rather than trusting the exit code: the backup is the whole safety story.
_src_n=$(find "$DST" -type f | wc -l | tr -d ' ')
_bak_n=$(find "$BACKUP_DIR/tree" -type f | wc -l | tr -d ' ')
[ "$_bak_n" -ge "$_src_n" ] || { red "backup is short ($_bak_n of $_src_n files) -- refusing to upgrade"; exit 2; }
grep -E '^(NEW|UPDATED)	' "$PLAN" | cut -f1,2 > "$BACKUP_DIR/_upgrade-receipt.txt"
{
  printf 'talos upgrade %s\n' "$STAMP"
  printf 'from_version=%s\n' "$OLD_VERSION"
  printf 'to_version=%s\n' "$NEW_VERSION"
  printf 'source=%s\n' "$SRC"
  printf 'target=%s\n' "$DST"
  printf 'files_backed_up=%s\n' "$_bak_n"
} > "$BACKUP_DIR/_upgrade-info.txt"
hdr "BACKUP"
echo "  $_bak_n files -> $BACKUP_DIR/tree"
echo "  undo:  bash \"$SRC/scripts/upgrade.sh\" --rollback \"$BACKUP_DIR\" --into \"$DST\""

# ---------------------------------------------------------------------------
# APPLY.
# ---------------------------------------------------------------------------
hdr "APPLYING"
_written=0
while IFS='	' read -r kind rel why; do
  case "$kind" in NEW|UPDATED) ;; *) continue ;; esac
  mkdir -p "$DST/$(dirname "$rel")" || { red "could not create the directory for $rel"; exit 1; }
  cp "$SRC/$rel" "$DST/$rel" || { red "could not write $rel -- stopping. Roll back."; exit 1; }
  _written=$((_written+1))
done < "$PLAN"
# The kit relies on these being executable; a copy does not always carry the bit.
chmod +x "$DST"/hooks/*.py 2>/dev/null || true
chmod +x "$DST"/scripts/*.sh 2>/dev/null || true
echo "  wrote $_written file(s)"

# ---------------------------------------------------------------------------
# THE SECOND CHECK. Independent of the plan: re-read .upgradeignore, re-walk the
# target, and compare every protected file against the backup byte for byte. If
# the plan had a bug, this is what catches it -- so it must not reuse the plan.
# ---------------------------------------------------------------------------
_violations=$(python3 - "$UPIGNORE" "$BACKUP_DIR/tree" "$DST" <<PYEOF
$MATCHER
import os, sys, hashlib
up, before, after = sys.argv[1], sys.argv[2], sys.argv[3]
pats = load(up)
def dg(p):
    h = hashlib.sha256()
    with open(p,'rb') as fh:
        for c in iter(lambda: fh.read(65536), b''): h.update(c)
    return h.hexdigest()
bad = []
for root, dirs, files in os.walk(before):
    rr = os.path.relpath(root, before); rr = '' if rr == '.' else rr
    for name in files:
        rel = (rr + '/' + name).lstrip('/') if rr else name
        prot, why = verdict(rel, pats)
        if not prot: continue
        b, a = os.path.join(before, rel), os.path.join(after, rel)
        if not os.path.exists(a):
            bad.append('DELETED  ' + rel); continue
        try:
            if dg(b) != dg(a): bad.append('MODIFIED ' + rel + '   [' + why + ']')
        except OSError as e:
            bad.append('UNREADABLE ' + rel + ' ' + str(e))
print('\n'.join(bad))
PYEOF
)
hdr "VERIFYING THE BOUNDARY HELD"
if [ -n "$_violations" ]; then
  red "PROTECTED FILES WERE CHANGED. This is a bug in the upgrade, not in your folder:"
  printf '%s\n' "$_violations" | sed 's/^/    /' >&2
  red "Roll back now:  bash \"$SRC/scripts/upgrade.sh\" --rollback \"$BACKUP_DIR\" --into \"$DST\""
  exit 1
fi
grn "  every protected file is byte-for-byte what it was before the upgrade"

# ---------------------------------------------------------------------------
# The stamp. Written by the upgrade, never preserved through it -- a version
# number that survives an upgrade is a version number that lies.
# ---------------------------------------------------------------------------
{
  printf '# Written by scripts/upgrade.sh. What this folder is running.\n'
  if [ -f "$SRC/.talos-release" ]; then
    grep -v '^#' "$SRC/.talos-release"
  else
    printf 'version=%s\n' "$NEW_VERSION"
    printf 'kind=%s\n' "$NEW_KIND"
    [ -n "$NEW_COMMIT" ] && printf 'source_commit=%s\n' "$NEW_COMMIT"
  fi
  [ -n "$OLD_INSTALLED" ] && printf 'installed=%s\n' "$OLD_INSTALLED"
  printf 'upgraded=%s\n' "$(date +%Y-%m-%d)"
  printf 'upgraded_from=%s\n' "$OLD_VERSION"
} > "$DST/.talos-version"
echo "  stamped .talos-version: $OLD_VERSION -> $NEW_VERSION"

# ---------------------------------------------------------------------------
# THE GATE.
# ---------------------------------------------------------------------------
if [ "$RUN_GATE" = 1 ]; then
  hdr "GATE -- scripts/self-test.sh in the upgraded folder"
  _st="$(cd "$DST" && TALOS_PLACEHOLDER_SRC="$SRC/CLAUDE.md" bash scripts/self-test.sh 2>&1)"
  _rc=$?
  printf '%s\n' "$_st" | grep -E 'FAIL|ALL .* CHECKS PASSED|passed,' | sed 's/^/  /'
  if [ "$_rc" -ne 0 ]; then
    red "THE GATE FAILED. Roll back:"
    red "  bash \"$SRC/scripts/upgrade.sh\" --rollback \"$BACKUP_DIR\" --into \"$DST\""
    exit 1
  fi

  hdr "REPORT (not a gate) -- scripts/verify-install.sh"
  echo "  This grades YOUR setup, not the new code. It can fail for reasons an upgrade did not"
  echo "  cause -- an interview that never finished, an empty wiki. Read it, do not panic at it."
  (cd "$DST" && bash scripts/verify-install.sh 2>&1) | grep -E 'FAIL|ALL .* CHECKS PASSED|passed,' | sed 's/^/  /'
fi

hdr "DONE"
echo "  $OLD_VERSION -> $NEW_VERSION"
echo "  backup:   $BACKUP_DIR"
echo "  rollback: bash \"$SRC/scripts/upgrade.sh\" --rollback \"$BACKUP_DIR\" --into \"$DST\""
if [ "$RUN_GATE" = 1 ]; then
  grn "  gate: self-test passed in the upgraded folder"
else
  red "  GATE NOT RUN (--no-gate). This upgrade is unproven. Run: cd \"$DST\" && bash scripts/self-test.sh"
fi
echo "  Exit and restart claude in the folder -- the new hooks load at session start."
exit 0
