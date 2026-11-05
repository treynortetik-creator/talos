#!/usr/bin/env bash
# test-default-agent.sh -- a new agent works right away, with no setup interview.
#   1. render the kit into a temp copy with scripts/render-default.py and run claude-md-lint.sh and self-test.sh on it
#   2. the upgrade carve-out: upgrade.sh updates the Talos-owned .claude/rules/talos-defaults.md and leaves an owner file alone
export PYTHONDONTWRITEBYTECODE=1
set -u
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)" || exit 2
case "$T" in /*/*) ;; *) echo "suspicious temp dir: $T" >&2; exit 2;; esac
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

copy_kit() { mkdir -p "$1"; ( cd "$KIT" && tar --exclude=./.git -cf - . ) | ( cd "$1" && tar -xf - ); }

# ---- 1. fresh render, no interview ----
R="$T/fresh"; copy_kit "$R"
if python3 "$R/scripts/render-default.py" --into "$R" >"$T/render.out" 2>&1; then ok "render-default.py renders with no interview"
else bad "render-default.py failed: $(tail -3 "$T/render.out")"; fi
[ -f "$R/CLAUDE.md" ] && ! grep -q '{{' "$R/CLAUDE.md" && ok "CLAUDE.md has no unrendered placeholder" || bad "CLAUDE.md missing or has {{ left"
[ "$(grep -c 'not yet captured' "$R/CLAUDE.md" 2>/dev/null)" -ge 3 ] && ok "waves 5-7 read 'not yet captured'" || bad "no 'not yet captured' placeholders"
[ -f "$R/wiki/me.md" ] && ok "stub wiki/me.md exists" || bad "wiki/me.md missing"
if ! grep -qE 'tutor|^## 0' "$R/CLAUDE.md" 2>/dev/null; then ok "no section 0 in the render"; else bad "section 0 in the render"; fi
if (cd "$R" && bash scripts/claude-md-lint.sh >"$T/lint.out" 2>&1); then ok "claude-md-lint.sh passes on a fresh render"
else bad "claude-md-lint.sh failed: $(tail -5 "$T/lint.out")"; fi
# self-test.sh runs suites that need macOS (the installer) or tools a Linux box may lack; on a platform where those three fail even
# for the untouched kit (confirmed on origin/main), only THEY may fail. Anything else failing is this render's fault.
(cd "$R" && bash scripts/self-test.sh >"$T/self.out" 2>&1); self_rc=$?
if [ "$self_rc" -eq 0 ]; then ok "self-test.sh passes on a fresh render"
else
  # FAIL lines, plus the `|` lines a failing check prints under itself
  other=$(grep -E 'FAIL|^ {8}\| ' "$T/self.out" | sed 's/\x1b\[[0-9;]*m//g' | grep -vE 'the installer suite fails|test-memory-reflex.sh fails|test-localmodels.sh fails|FAILED' )
  if [ "$(uname)" != Darwin ] && [ -z "$other" ]; then
    ok "self-test.sh passes on a fresh render (skip: installer, memory-reflex and localmodels suites fail on $(uname) with or without the render)"
  else bad "self-test.sh failed: $(printf '%s' "$other" | head -25)"; fi
fi
grep -q 'a correct install passes verify-install.sh' "$T/self.out" && grep -q 'PASS.*correct install passes verify-install' "$T/self.out" && ok "verify-install.sh passes inside self-test" || bad "verify-install check did not pass in self-test"

# ---- 1b. the render is complete: floor rules, name line, handoff, verify-install ----
for ph in 'do not retry or route around' 'never send, post, delete, spend or share' 'carries the substance' 'only one process may hold a channel' \
          'never infer authority' 'Never do these' '## 8. Guardrails'; do
  grep -qF "$ph" "$R/CLAUDE.md" && ok "render carries the floor rule: $ph" || bad "render is missing the floor rule: $ph"
done
grep -qF -- '- **Name:** not yet captured' "$R/CLAUDE.md" && ok "section 2 has a Name line, 'not yet captured'" || bad "section 2 has no Name line"
grep -qi 'finish onboarding' "$R/memory/HANDOFF.md" && bad "HANDOFF still says 'finish onboarding'" || ok "HANDOFF does not push the interview"
grep -qi 'interview is available' "$R/memory/HANDOFF.md" && ok "HANDOFF says the interview is available" || bad "HANDOFF does not mention the interview being available"
grep -q 'talos:placeholder' "$R/CLAUDE.md" && bad "the rendered CLAUDE.md still carries the placeholder marker" || ok "the render has no placeholder marker"
grep -q 'not_offered' "$R/wiki/_onboarding-progress.md" 2>/dev/null && ok "_onboarding-progress.md exists with state not_offered" || bad "_onboarding-progress.md missing or not not_offered"
G="$T/vi"; copy_kit "$G"; mkdir -p "$G/.claude"; cp "$G/templates/dot-claude/settings.json" "$G/.claude/settings.json"
python3 "$G/scripts/render-default.py" --into "$G" >/dev/null 2>&1
( cd "$G" && git init -q && git add -A && git -c user.name=t -c user.email=t@example.com commit -qm day-zero ) >/dev/null 2>&1
( cd "$G" && bash scripts/verify-install.sh >"$T/vi.out" 2>&1 ); vi_rc=$?
if [ "$vi_rc" -eq 0 ] && ! grep -q 'FAIL' "$T/vi.out"; then ok "the default render passes verify-install.sh with 0 failures"
else bad "verify-install.sh on the default render (rc=$vi_rc): $(sed 's/\x1b\[[0-9;]*m//g' "$T/vi.out" | grep FAIL | head -5)"; fi

# ---- 1c. the shipped placeholder: one marker, every detector sees it ----
P="$T/ph"; copy_kit "$P"; mkdir -p "$P/.claude"; cp "$P/templates/dot-claude/settings.json" "$P/.claude/settings.json"
grep -q '<!-- talos:placeholder -->' "$KIT/CLAUDE.md" && ok "kit/CLAUDE.md carries <!-- talos:placeholder -->" || bad "kit/CLAUDE.md has no placeholder marker"
cp "$KIT/CLAUDE.md" "$P/CLAUDE.md"
( cd "$P" && bash scripts/verify-install.sh 2>&1 ) | grep -q 'FAIL.*shipped placeholder' && ok "verify-install.sh detects the shipped placeholder" || bad "verify-install.sh cannot see the shipped placeholder"
( cd "$P" && bash scripts/claude-md-lint.sh 2>&1 ) | grep -q '^skip:' && ok "claude-md-lint.sh skips the shipped placeholder" || bad "claude-md-lint.sh cannot see the shipped placeholder"
grep -q 'talos:placeholder' "$KIT/BOOTSTRAP.md" && grep -q 'talos:placeholder' "$KIT/UPGRADE.md" && ok "BOOTSTRAP and UPGRADE name the marker" || bad "BOOTSTRAP/UPGRADE still name the old first line"

# ---- 1d. render-default.py never overwrites a tuned CLAUDE.md, or any other file ----
U="$T/tuned"; copy_kit "$U"; printf '# CLAUDE.md\nmy tuned config, hand edited\n' > "$U/CLAUDE.md"; cp "$U/CLAUDE.md" "$T/tuned.orig"
mkdir -p "$U/memory" "$U/wiki"; echo "mine" > "$U/memory/STATE.md"; echo "my me" > "$U/wiki/me.md"
python3 "$U/scripts/render-default.py" --into "$U" >"$T/tuned.out" 2>&1; rrc=$?
{ [ "$rrc" -ne 0 ] && cmp -s "$U/CLAUDE.md" "$T/tuned.orig"; } && ok "a tuned CLAUDE.md survives byte-identical and the renderer exits non-zero" || bad "tuned CLAUDE.md overwritten or exit 0 (rc=$rrc)"
grep -qi 'refus' "$T/tuned.out" && ok "the refusal says so" || bad "the refusal is silent: $(cat "$T/tuned.out")"
{ [ "$(cat "$U/memory/STATE.md")" = mine ] && [ "$(cat "$U/wiki/me.md")" = "my me" ]; } && ok "other existing files are untouched" || bad "an existing file was overwritten"

# a CLAUDE.md that merely contains the marker (quoted, or edited under the placeholder) is still the owner's
W="$T/withmark"; copy_kit "$W"; { cat "$KIT/CLAUDE.md"; echo "MY RULE: keep this"; } > "$W/CLAUDE.md"; cp "$W/CLAUDE.md" "$T/withmark.orig"
python3 "$W/scripts/render-default.py" --into "$W" >/dev/null 2>&1; wrc=$?
{ [ "$wrc" -ne 0 ] && cmp -s "$W/CLAUDE.md" "$T/withmark.orig"; } && ok "a CLAUDE.md with the marker plus the owner's own lines is refused, byte-identical" || bad "an edited placeholder was overwritten (rc=$wrc)"
{ [ ! -e "$W/memory/tasks.md" ] && [ ! -e "$W/wiki/_onboarding-progress.md" ]; } && ok "a refused run creates no files" || bad "a refused run created files"
# the shipped placeholder itself is still replaced
S="$T/shipped"; copy_kit "$S"; cp "$KIT/CLAUDE.md" "$S/CLAUDE.md"
python3 "$S/scripts/render-default.py" --into "$S" >/dev/null 2>&1 && ! grep -q 'talos:placeholder' "$S/CLAUDE.md" && ok "the byte-identical shipped placeholder is rendered over" || bad "the shipped placeholder was not rendered"

# ---- 1e. no broken capitals left by the mechanical replace ----
if grep -rn -A1 'a recommendation$' "$KIT/templates" | grep -q 'The owner' || grep -rnE '[.!?] the owner|[a-z,] The owner' "$KIT/templates" "$KIT/optional" | grep -q .; then
  bad "broken capital around 'the owner' in the kit"
else ok "no broken capital around 'the owner' in templates or optional skills"; fi

# ---- 2. upgrade carve-out ----
S="$T/newkit"; copy_kit "$S"
D="$T/agent"; mkdir -p "$D/.claude/rules" "$D/wiki"
echo "OLD talos defaults" > "$D/.claude/rules/talos-defaults.md"
echo "my own rule" > "$D/.claude/rules/mine.md"
echo "my own config" > "$D/CLAUDE.md"
echo "my own me" > "$D/wiki/me.md"
bash "$S/scripts/upgrade.sh" --into "$D" --no-gate >"$T/up.out" 2>&1; up_rc=$?
[ "$up_rc" -eq 0 ] && ok "upgrade.sh exits 0" || bad "upgrade.sh exited $up_rc: $(tail -3 "$T/up.out")"
[ "$(cat "$D/wiki/me.md")" = "my own me" ] && ok "upgrade left wiki/me.md unchanged" || bad "wiki/me.md was touched by the upgrade"
cmp -s "$D/.claude/rules/talos-defaults.md" "$S/.claude/rules/talos-defaults.md" && ok "upgrade updated talos-defaults.md" || bad "talos-defaults.md was not updated"
[ "$(cat "$D/.claude/rules/mine.md")" = "my own rule" ] && ok "upgrade left the owner's rules file alone" || bad "owner rules file was touched"
[ "$(cat "$D/CLAUDE.md")" = "my own config" ] && ok "upgrade left CLAUDE.md alone" || bad "CLAUDE.md was touched"

echo "default-agent: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
