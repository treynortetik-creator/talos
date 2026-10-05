#!/usr/bin/env bash
# verify-install.sh — mechanically check that setup actually worked.
#
# Run from your agent folder:   bash scripts/verify-install.sh
#
# WHY THIS EXISTS
# ---------------
# The bootstrap used to end in a checklist. A dry run found that the checklist
# PASSED only when the agent deviated from the procedure, and FAILED when it
# followed it -- and nothing caught that, because a checklist is just prose that
# an agent (or a tired human) ticks off without executing.
#
# Six of the eight checks were mechanically verifiable all along. So they are
# mechanical now. If this script says PASS, setup really is done.

HERE="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$HERE/.." || exit 1
pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
note() { printf '        %s\n' "$1"; }

echo "Verifying install in: $(pwd)"
echo

# 1. no unrendered placeholders anywhere live
hits=$(grep -rlE '\{\{[A-Z_]+\}\}' CLAUDE.md wiki/ memory/ .learnings/ .claude/ 2>/dev/null | grep -v '/examples/')
if [ -z "$hits" ]; then ok "no unrendered {{placeholders}}"
else bad "unrendered placeholders remain"; note "$(echo "$hits" | tr '\n' ' ')"; fi

# 2. the config exists, is not the shipped placeholder, and the tutor section is gone
# 2026-09-02 (review lane A, reproduced): this used to test only for the tutor phrase, which the
# shipped placeholder CLAUDE.md never contained -- so an install where BOOTSTRAP step 2 never
# rendered the config (no persona, no NEVER_DO, no guardrails) printed ALL CHECKS PASSED.
if [ ! -f CLAUDE.md ]; then bad "CLAUDE.md missing"
elif grep -q '^# Setup is not finished' CLAUDE.md; then
  bad "CLAUDE.md is still the shipped placeholder -- BOOTSTRAP step 2 never rendered the config"
  note "render templates/CLAUDE.md.tmpl over it (BOOTSTRAP step 2), then re-run"
elif grep -q "you are the tutor" CLAUDE.md; then
  bad "CLAUDE.md still contains section 0 (the tutor block)"
  note "delete it — setup is finished"
else ok "CLAUDE.md rendered, section 0 removed"; fi

# 3. the hook is registered on the four required matchers (plus fork, when present)
# 2026-08-27 (TALOS-05, reproduced): this used to `grep` settings.json for the WORDS
# startup/resume/clear/compact and CLAUDE_PROJECT_DIR. A file that merely mentions those
# strings (a comment, an unrelated key, a no-op hook) earned every PASS line and the green
# ALL CHECKS PASSED. A verifier that greps for vocabulary certifies vocabulary. Parse the
# real schema instead: right event, right matchers, right command.
if [ ! -f .claude/settings.json ]; then bad ".claude/settings.json missing"
else
  _hookchk=$(python3 "$HERE/_check_hook_registration.py" 2>&1)
  case "$_hookchk" in
    OK*) ok "SessionStart hook parsed: ${_hookchk#OK }" ;;
    *)   bad "${_hookchk#ERR }" ;;
  esac
fi

# 4. the hook actually runs and emits USABLE context
# Two things this has to get right, both learned the hard way:
#
# (a) TALOS-05: "emits valid JSON" is not a check. `{}` is valid JSON, and `{}` is exactly
#     what a no-op hook, a crashed hook, and our own fail-closed guard all emit. Require a
#     non-empty additionalContext, which is the only output that does the user any good.
#
# (b) TALOS-16: a verifier must not mutate the thing it is verifying. The hook writes
#     .last-lint / .last-ledger-review as a side effect. Deleting only the ones WE created
#     was not enough -- if a stamp already existed and was stale, the run REFRESHED it and
#     silently pushed the user's next lint or ledger review a full cycle into the future.
#     So snapshot content AND mtime, and put them back byte-for-byte.
if [ -f hooks/session-start.py ]; then
  _snapdir="$(mktemp -d)" || { echo "mktemp -d failed; skipping hook run check" >&2; _snapdir=""; }
  _stamps="memory/.last-lint memory/.last-ledger-review memory/.last-commit-nudge"
  if [ -n "$_snapdir" ]; then
    for s_ in $_stamps; do
      [ -f "$s_" ] && cp -p "$s_" "$_snapdir/$(basename "$s_")"
    done
  fi

  _out=$(python3 hooks/session-start.py 2>/dev/null)
  _ctx=$(printf '%s' "$_out" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("ERR not valid JSON"); raise SystemExit
if not isinstance(d, dict):
    print("ERR output is not a JSON object"); raise SystemExit
c = (d.get("hookSpecificOutput") or {}).get("additionalContext")
if not c:
    print("ERR hook emitted no additionalContext (a no-op hook passes an existence check but tells the agent nothing)")
else:
    print("OK %d" % len(c))
' 2>/dev/null)

  # restore: put back what was there, drop what was not
  for s_ in $_stamps; do
    if [ -n "$_snapdir" ] && [ -f "$_snapdir/$(basename "$s_")" ]; then
      cp -p "$_snapdir/$(basename "$s_")" "$s_"
    else
      rm -f "$s_"
    fi
  done
  [ -n "$_snapdir" ] && rm -rf "$_snapdir"

  case "$_ctx" in
    OK\ *) if printf '%s' "$_out" | grep -q 'No prior session state found'; then
             ok "hook runs and emits ${_ctx#OK } chars of context (the fresh-install message; no memory yet)"
           else ok "hook runs and emits ${_ctx#OK } chars of context"; fi ;;
    *)     bad "${_ctx#ERR }" ;;
  esac
else bad "hooks/session-start.py missing"; fi

# 5. required files exist
for f in memory/STATE.md memory/tasks.md memory/decisions-ledger.md memory/rules-ledger.md \
         memory/HANDOFF.md wiki/_index.md wiki/me.md \
         .learnings/ERRORS.md .learnings/LEARNINGS.md \
         .learnings/FEATURE_REQUESTS.md .learnings/GRADUATION_LOG.md; do
  [ -f "$f" ] && ok "$f" || bad "$f missing"
done

# 5b. the config is a hot file: under the word cap, every red-marked rule keyed, every key in the ledger
if [ -f scripts/claude-md-lint.sh ] && [ -f CLAUDE.md ] && ! grep -q '^# Setup is not finished' CLAUDE.md; then
  _lint=$(bash scripts/claude-md-lint.sh 2>&1); _lrc=$?
  if [ "$_lrc" -eq 0 ]; then ok "CLAUDE.md lint: $(printf '%s' "$_lint" | head -1 | sed 's/^ok: //')"
  else bad "CLAUDE.md lint failed (scripts/claude-md-lint.sh)"; note "$(printf '%s' "$_lint" | grep FAIL | head -3 | tr '\n' ' ')"; fi
fi
# STATE.md is injected at every session boundary; past 30,000 characters it is dead weight. A note, not a failure.
if [ -f memory/STATE.md ]; then
  _sn=$(python3 -c 'import sys; print(len(open(sys.argv[1], encoding="utf-8", errors="replace").read()))' memory/STATE.md 2>/dev/null || echo 0)
  [ "${_sn:-0}" -gt 30000 ] && note "memory/STATE.md is $_sn characters (ceiling 30000): evict closed rows to the daily log"
fi

# 6. me.md is real: frontmatter + >=2 links, and something links back to it
if [ -f wiki/me.md ]; then
  head -1 wiki/me.md | grep -q '^---' && ok "wiki/me.md has frontmatter" || bad "wiki/me.md has no frontmatter"
  n=$(grep -o '\[\[[^]|#]*' wiki/me.md | sort -u | wc -l | tr -d ' ')
  [ "$n" -ge 2 ] && ok "wiki/me.md has $n outbound links" || bad "wiki/me.md has only $n outbound links (need 2)"
  grep -q '\[\[me\]\]' wiki/_index.md 2>/dev/null && ok "wiki/_index.md links to me" || bad "wiki/_index.md does not link to [[me]]"
fi

# 6b. the onboarding progress file (BOOTSTRAP's done-criteria requires it; it is the resume anchor)
[ -f wiki/_onboarding-progress.md ] && ok "wiki/_onboarding-progress.md" \
  || bad "wiki/_onboarding-progress.md missing -- a dead session cannot resume without it"

# 7. the wiki lints clean
if [ -f scripts/wiki-lint.py ]; then
  out=$(python3 scripts/wiki-lint.py wiki 2>/dev/null | tail -1)
  case "$out" in
    clean*) ok "wiki lints clean" ;;
    empty*) bad "wiki is empty -- step 7 never wrote any notes"; note "run: python3 scripts/wiki-lint.py wiki" ;;
    *)     bad "wiki lint: $out"; note "run: python3 scripts/wiki-lint.py wiki" ;;
  esac
fi

# 8. the secret file is actually protected, not just mentioned in .gitignore
# 2026-08-27 (TALOS-06, reproduced): this used to grep .gitignore for a `.env` line and
# call it protected. A .env that was force-added and committed passed that check -- the
# ignore rule does nothing once a file is tracked, and the secret was already in history.
# Ask git what git actually thinks, and ask it both questions.
if [ -f .env ]; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    if git ls-files --error-unmatch .env >/dev/null 2>&1; then
      bad ".env is TRACKED BY GIT -- the secret is in your history, not just your working copy"
      note "git rm --cached .env   then rotate every credential in it; history rewrite is a separate job"
    elif git check-ignore -q .env; then
      ok ".env exists, is untracked, and git confirms it is ignored"
    else
      bad ".env exists and is NOT ignored by git -- one 'git add .' from being committed"
    fi
  else
    grep -q '^\.env$' .gitignore 2>/dev/null \
      && ok ".env exists and .gitignore lists it (no git repo here to confirm)" \
      || bad ".env exists but .gitignore does not list it"
  fi
  # An ignore rule keeps a secret out of git. It does nothing to keep it away from the
  # agent, which can read any file it is pointed at. The deny rule is the part that does.
  if [ -f .claude/settings.json ] && grep -q '"deny"' .claude/settings.json \
     && grep -q '\.env' .claude/settings.json; then
    ok "agent reads of .env are denied in .claude/settings.json"
  else
    bad "nothing stops the AGENT reading .env -- add a permissions.deny rule for it"
    note 'in .claude/settings.json: "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)"] }'
  fi
else ok ".env absent (fine -- nothing needed one)"; fi

# 8b. the day-zero snapshot exists (BOOTSTRAP step 7.7). The checklist required it and this
# script said it checked "all of the above"; it did not. Undo history is the reason git is here.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git log -1 >/dev/null 2>&1; then ok "git repo with a commit (undo history exists)"
  else bad "git repo has no commits -- BOOTSTRAP step 7.7 (day-zero commit) never ran"; fi
else bad "no git repo -- BOOTSTRAP step 7.7 (git init + day-zero commit) never ran"
     note "git init && git add memory wiki .claude CLAUDE.md && git commit -m 'day zero'"; fi

# ── scheduling (Chronos). Informational only: the agent works without it, so this never fails the install. ──
if [ -f "${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}" ] && [ -f scripts/talos-jobs.py ]; then
  _jobs=$(python3 scripts/talos-jobs.py list 2>/dev/null)
  if printf '%s' "$_jobs" | grep -q '^talos-'; then
    note "scheduling: Chronos found. $(printf '%s\n' "$_jobs" | grep -c ' ON ') of $(printf '%s\n' "$_jobs" | grep -c '^talos-') Talos job(s) enabled."
  else
    note "scheduling: Chronos found, but no Talos jobs are registered (python3 scripts/talos-jobs.py register --agent-dir .)"
  fi
  # Scheduled runs start in Chronos's workspace. If that is not this folder, this agent's CLAUDE.md, hooks and
  # pre-tool guard do not load for them. A note, not a failure: the agent itself works.
  _ws=$(python3 - "${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}" <<'PYWS'
import json, os, sys
try:
    w = json.load(open(sys.argv[1])).get("workspace") or ""
    print(os.path.realpath(os.path.expanduser(w)) if w else "")
except Exception:
    print("")
PYWS
)
  if [ -n "$_ws" ] && [ "$_ws" != "$(pwd -P)" ]; then
    note "scheduling WARNING: Chronos's workspace is $_ws, not this folder. Scheduled runs start there, so this"
    note "  agent's CLAUDE.md, hooks and guard do not load for them. Fix: ./install.sh --set-chronos-workspace, or edit \"workspace\" in the Chronos config."
  fi
else
  note "scheduling: Chronos not found. That is fine: the agent has no timers. See README, 'Chronos'."
fi

# The pre-tool guard: the half of secret protection the .env deny rule cannot do (cat .env via Bash).
if [ -f .claude/settings.json ] && python3 - <<'PYCHK'
import json, sys
try: d = json.load(open(".claude/settings.json"))
except Exception: sys.exit(1)
hooks = d.get("hooks", {}).get("PreToolUse", [])
sys.exit(0 if any("pre-tool-guard.py" in h.get("command","") for e in hooks if e.get("matcher")=="Bash" for h in e.get("hooks",[])) else 1)
PYCHK
then ok "pre-tool guard is registered on PreToolUse for Bash"
else bad "pre-tool guard is NOT registered -- cat .env and rm -rf are unguarded through Bash"
     note 'copy the hooks block from templates/dot-claude/settings.json'; fi

# The enforcement hooks (claim gate, append-only guard, sub-agent log, statusline, channel debt) are extras:
# reported as notes, never failures, so an older install is not told it is broken for lacking a nice-to-have.
if [ -f .claude/settings.json ]; then
  python3 - <<'PYHK' | while IFS= read -r _l; do note "$_l"; done
import json, os, re
try:
    d = json.load(open(".claude/settings.json"))
except Exception:
    raise SystemExit
reg = set()
for ev, entries in (d.get("hooks") or {}).items():
    for e in entries or []:
        for h in e.get("hooks", []):
            c = h.get("command", "")
            m = re.search(r"hooks/([A-Za-z0-9_.-]+\.py)", c)
            if m and "$CLAUDE_PROJECT_DIR" in c:      # this folder's hooks only (Chronos's own hook lives elsewhere)
                reg.add(m.group(1))
if "hooks/statusline.py" in json.dumps(d.get("statusLine") or {}):
    reg.add("statusline.py")
extras = ["claim-gate.py", "append-only-guard.py", "agent-log.py", "statusline.py", "channel-debt.py", "hands-free.py", "check-vault.py", "timeline-guard.py"]
have = [x for x in extras if os.path.isfile("hooks/" + x)]
on = [x for x in have if x in reg]
off = [x for x in have if x not in reg]
stale = sorted(r for r in reg if not os.path.isfile("hooks/" + r))
if have:
    print("hooks: %d of %d enforcement hooks registered (%s)" % (len(on), len(have), ", ".join(on) or "none"))
if off:
    print("hooks: present but NOT registered: %s (merge the hooks block from templates/dot-claude/settings.json)" % ", ".join(off))
if stale:
    print("hooks WARNING: registered but the file is missing: %s (remove the registration)" % ", ".join(stale))
PYHK
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mALL %d CHECKS PASSED.\033[0m Setup is done — open HOMEWORK.md.\n' "$pass"
  exit 0
else
  printf '\033[31m%d passed, %d FAILED.\033[0m Fix the failures above before continuing.\n' "$pass" "$fail"
  exit 1
fi
