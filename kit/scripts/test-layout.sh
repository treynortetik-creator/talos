#!/usr/bin/env bash
# test-layout.sh -- memory layout 1 (wiki/ at the top of the agent folder, today's default) and layout 2 (a `layout=2` line in
# .talos-version: the wiki lives at memory/wiki/). Every kit hook and script that names the wiki folder asks ONE resolver
# (scripts/_talos_layout.py, copied into hooks/_talos_common.py and the two other standalone hooks); this suite builds the same
# small agent twice, once per layout, and asserts the same observable result from each of them. A layout-1 agent must behave
# exactly as it always did; a layout-2 agent must be read from memory/wiki/. Nothing here writes layout 2 (the installer does not,
# yet). Everything runs in a throwaway folder with a throwaway HOME and XDG state: never the real HOME or ~/talos-agent.
#
# Usage: scripts/test-layout.sh
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "${2:0:700}"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home" XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg" XDG_DATA_HOME="$SB/data" TALOS_APP_HOME="$SB/app"
talos_test_sandbox "$SB"
mkdir -p "$HOME"
unset CLAUDE_PROJECT_DIR CHRONOS_RUN TALOS_UNATTENDED TALOS_SESSION_ROLE TALOS_TIMELINE_GUARD_OFF CHRONOS_CONFIG

SEP='<!-- TIMELINE:APPEND-ONLY -->'
FM() { printf -- '---\ntitle: %s\ntype: %s\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# %s\n' "$1" "$2" "$1"; }

# mkagent DIR LAYOUT [kitwiki]: a small agent folder. Hooks and the scripts under test are COPIES (as in an old-layout install),
# so the agent really is the folder the copies sit in. With `kitwiki` the wiki is the one a new agent starts with (no notes).
mkagent() {
  local A="$1" L="$2" W f
  rm -rf "$A"; mkdir -p "$A/hooks" "$A/scripts/memory" "$A/scripts/dream" "$A/templates" "$A/memory" "$A/.learnings"
  cp "$KIT"/hooks/*.py "$A/hooks/"
  for f in _agent_root.py _talos_layout.py wiki-search.sh recall.py weekly-wiki-check.sh wiki-lint.py deep-dive-select.py onboarding-state.py weekly-snapshot.sh verify-install.sh wiki-gazetteer.py; do
    [ -f "$KIT/scripts/$f" ] && cp "$KIT/scripts/$f" "$A/scripts/"
  done
  cp "$KIT"/scripts/memory/*.py "$A/scripts/memory/"; cp "$KIT"/scripts/dream/*.py "$A/scripts/dream/"
  cp "$KIT/templates/_onboarding-progress.md.tmpl" "$A/templates/"
  printf 'version=1.2.0-cli\n' > "$A/.talos-version"
  if [ "$L" = 2 ]; then printf 'layout=2\n' >> "$A/.talos-version"; W="$A/memory/wiki"; else W="$A/wiki"; fi
  mkdir -p "$W"
  if [ "${3:-}" = kitwiki ]; then cp -R "$KIT/wiki/." "$W/"; return; fi
  mkdir -p "$W/people" "$W/concepts"
  { FM "Quillfeather Ames" person; printf 'Owner of this agent. See [[dana-ruiz]] and [[fleet-vehicles]].\n'; } > "$W/me.md"
  { FM "Dana Ruiz" person; printf 'Dana leads vendor procurement. See [[quillfeather-ames]].\n'; } > "$W/people/dana-ruiz.md"
  { FM "Fleet vehicles" concept; printf 'The delivery van needed brake pads. See [[dana-ruiz]].\n'; } > "$W/concepts/fleet-vehicles.md"
  { FM "Zorptastic widgets" concept; printf 'The zorptastic widget line ships in March. See [[fleet-vehicles]].\n'; } > "$W/concepts/zorptastic-widgets.md"
  { FM "Quarterly budget" concept; printf 'The budget review happens each quarter. See [[dana-ruiz]].\n'; } > "$W/concepts/quarterly-budget.md"
  { FM "Team offsite" concept; printf 'A planning retreat. See [[quarterly-budget]]. Also [[nowhere-here]].\n'; } > "$W/concepts/team-offsite.md"
  { printf '# Changelog\n\n| Date | What changed |\n|---|---|\n'; for i in 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1; do printf '| 2026-01-%02d | **note %s** a row long enough to count toward the size floor |\n' "$i" "$i"; done; } > "$W/_changelog.md"
  { printf '# Onboarding progress\n\n| Wave | What | State | Date |\n|---|---|---|---|\n'; for i in 1 2 3 4 5 6 7 8; do printf '| %s | wave %s | done | 2026-01-01 |\n' "$i" "$i"; done; printf '\n### Wave 1 — done 2026-01-01\nName: Ada\n'; } > "$W/_onboarding-progress.md"
  printf -- '# 2026-03-02\nSigned off the vendor renewal.\n' > "$A/memory/2026-03-02.md"
}

# ---------------------------------------------------------------------------------------------------- the resolver
echo "== the resolver"
[ -f "$KIT/scripts/_talos_layout.py" ] && ok "scripts/_talos_layout.py exists" || no "scripts/_talos_layout.py is missing"

for L in 1 2; do
  A="$SB/agent$L"; mkagent "$A" "$L"
  if [ "$L" = 2 ]; then WANT_WIKI="$A/memory/wiki"; WANT_PROJ="$A/memory/projects"; else WANT_WIKI="$A/wiki"; WANT_PROJ=""; fi
  R() { python3 "$A/scripts/_talos_layout.py" "$A" "$@"; }
  got="$(R wiki 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && [ "$got" = "$WANT_WIKI" ]; } && ok "layout $L: _talos_layout.py wiki prints $WANT_WIKI" || no "layout $L: wiki gave rc=$rc '$got', wanted '$WANT_WIKI'"
  got="$(R memory 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && [ "$got" = "$A/memory" ]; } && ok "layout $L: memory prints the memory folder" || no "layout $L: memory gave rc=$rc '$got'"
  got="$(R projects 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && [ "$got" = "$WANT_PROJ" ]; } && ok "layout $L: projects prints '${WANT_PROJ:-<nothing: layout 1 has none>}'" || no "layout $L: projects gave rc=$rc '$got', wanted '$WANT_PROJ'"
  got="$(R bogus 2>&1)"; rc=$?
  [ "$rc" = 2 ] && ok "layout $L: an unknown key exits 2" || no "layout $L: unknown key gave rc=$rc '$got'"
  got="$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import _talos_layout as T; p = T.paths(sys.argv[2]); print(T.layout(sys.argv[2]), p["memory"], p["wiki"], p["projects"])' "$A/scripts" "$A" 2>&1)"
  [ "$got" = "$L $A/memory $WANT_WIKI ${WANT_PROJ:-None}" ] && ok "layout $L: layout() and paths() agree with the table" || no "layout $L: layout()/paths() gave '$got'"
done

# no .talos-version, or no layout= line, is layout 1; a value other than 1 or 2 is refused with a message, never guessed
A="$SB/agent-nover"; mkagent "$A" 1; rm -f "$A/.talos-version"
[ "$(python3 "$A/scripts/_talos_layout.py" "$A" wiki 2>&1)" = "$A/wiki" ] && ok "no .talos-version: layout 1" || no "no .talos-version did not give layout 1"
printf 'version=1.2.0-cli\nlayout=1\n' > "$A/.talos-version"
[ "$(python3 "$A/scripts/_talos_layout.py" "$A" wiki 2>&1)" = "$A/wiki" ] && ok "layout=1 written out is layout 1" || no "layout=1 did not give layout 1"
for bad in 3 0 two "" " 2x"; do
  printf 'version=1.2.0-cli\nlayout=%s\n' "$bad" > "$A/.talos-version"
  out="$(python3 "$A/scripts/_talos_layout.py" "$A" wiki 2>&1 >/dev/null)"; rc=$?
  { [ "$rc" = 1 ] && <<<"$out" grep -qi 'unknown layout'; } && ok "layout='$bad' exits 1 with a message" || no "layout='$bad' gave rc=$rc" "$out"
done

# the hooks keep private copies of the function (they stay standalone): every copy must give the resolver's answer
for L in 1 2; do
  A="$SB/agent$L"
  got="$(cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 - "$A" <<'PY' 2>&1
import importlib.util, os, sys
A = sys.argv[1]
sys.path.insert(0, os.path.join(A, "hooks"))
import _talos_common as C
import _talos_session as S
sys.path.insert(0, os.path.join(A, "scripts"))
import _talos_layout as T
spec = importlib.util.spec_from_file_location("ss", os.path.join(A, "hooks", "session-start.py"))
ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
want = T.paths(A)["wiki"]
print("same" if (C.wiki_dir(A) == want and S.wiki_dir(A) == want and ss.wiki_dir(A) == want) else "DIFFERENT %r %r %r %r" % (want, C.wiki_dir(A), S.wiki_dir(A), ss.wiki_dir(A)))
PY
)"
  [ "$got" = same ] && ok "layout $L: _talos_common, _talos_session and session-start give the resolver's wiki folder" || no "layout $L: a hook's copy of the resolver differs" "$got"
done

# ---------------------------------------------------------------------------------------------------- the consumers, per layout
for L in 1 2; do
  A="$SB/agent$L"; if [ "$L" = 2 ]; then WREL="memory/wiki"; else WREL="wiki"; fi
  echo "== layout $L (wiki at $WREL/)"

  # wiki-search.sh finds a note that is only in this layout's wiki
  out="$(cd "$A" && bash scripts/wiki-search.sh zorptastic 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" grep -q '1 note(s) matched' && <<<"$out" grep -q "^  $WREL/concepts/zorptastic-widgets.md\$"; } \
    && ok "layout $L: wiki-search.sh finds the note under $WREL/" || no "layout $L: wiki-search.sh" "rc=$rc $out"

  # recall.py: the lexical arm lists the note; and the positive control (the H1 of the wiki's me.md) is read from this wiki
  out="$(cd "$A" && python3 scripts/recall.py "zorptastic" 2>&1)"
  <<<"$out" grep -q "$WREL/concepts/zorptastic-widgets.md" && ok "layout $L: recall.py lists the note" || no "layout $L: recall.py did not list the note" "$out"
  out="$(cd "$A" && python3 scripts/recall.py "qqqzzznothere" 2>&1)"
  <<<"$out" grep -q 'positive control "quillfeather" matched' && ok "layout $L: recall.py's positive control comes from $WREL/me.md" || no "layout $L: recall.py's positive control is not me.md's H1" "$out"

  # session-start: the lint text comes from this wiki, and the setup offer is judged from this wiki's progress file (all
  # eight waves done there = an old agent, never offered setup)
  ctx="$(printf '{"source":"startup"}' | ( cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ))"
  <<<"$ctx" grep -q 'WIKI MAINTENANCE' && <<<"$ctx" grep -q 'broken links' && ok "layout $L: session-start injects the lint findings of $WREL/" || no "layout $L: session-start did not lint this wiki" "${ctx:0:300}"
  if <<<"$ctx" grep -q 'SETUP (offer once)'; then no "layout $L: session-start offered setup although $WREL/_onboarding-progress.md says all waves are done"
  else ok "layout $L: session-start reads the onboarding progress from $WREL/"; fi

  # onboarding-state.py reads _onboarding-progress.md from this wiki (wave 1 is already recorded there)
  rm -rf "$A/.agent-state"
  out="$(cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 scripts/onboarding-state.py start 2>&1; printf 'Name: Ada\n' | CLAUDE_PROJECT_DIR="$A" python3 scripts/onboarding-state.py record --wave 1 2>&1)"
  <<<"$out" grep -q 'wave 1 already recorded' && ok "layout $L: onboarding-state.py reads $WREL/_onboarding-progress.md" || no "layout $L: onboarding-state.py did not find the progress file" "$out"
  rm -rf "$A/.agent-state"

  # the append-only guard protects this wiki's changelog against a shrinking overwrite
  CL="$A/$WREL/_changelog.md"
  out="$(python3 -c 'import json,sys; print(json.dumps({"tool_name":"Write","tool_input":{"file_path":sys.argv[1],"content":"# Changelog\n"}}))' "$CL" | ( cd "$A" && python3 hooks/append-only-guard.py 2>&1 ))"
  <<<"$out" grep -q '"ask"' && ok "layout $L: append-only-guard protects $WREL/_changelog.md" || no "layout $L: append-only-guard let a shrinking write to the changelog through" "$out"

  # the timeline guard judges a note under this wiki
  BADNOTE="$(printf -- '---\ntitle: N\n---\n# N\n[[a]] [[b]]\n%s\n- **2026-09-23** | this transcript | @me -- Coached Pat\nwhile she deleted the classes. Confidence: high\n' "$SEP")"
  out="$(python3 -c 'import json,sys; print(json.dumps({"tool_name":"Write","tool_input":{"file_path":sys.argv[1],"content":sys.argv[2]}}))' "$A/$WREL/people/new.md" "$BADNOTE" | ( cd "$A" && python3 hooks/timeline-guard.py 2>&1 ))"
  <<<"$out" grep -q '"deny"' && ok "layout $L: timeline-guard denies a bad entry in a note under $WREL/" || no "layout $L: timeline-guard let a bad entry through" "$out"

  # dream/collect.py gathers the notes of this wiki
  out="$(cd "$SB" && python3 "$A/scripts/dream/collect.py" --no-recall --date 2026-11-01 2>&1)"; rc=$?
  n="$(python3 - "$A" <<'PY' 2>&1
import json, sys
d = json.load(open(sys.argv[1] + "/memory/dream/2026-11-01/collect.json"))
print(" ".join(sorted(p for p in (n["path"] for n in d.get("notes", [])) if "zorptastic" in p)) or "none")
PY
)"
  { [ "$rc" = 0 ] && [ "$n" = "$WREL/concepts/zorptastic-widgets.md" ]; } && ok "layout $L: dream/collect.py sees the notes of $WREL/" || no "layout $L: dream/collect.py did not gather $WREL/concepts/zorptastic-widgets.md" "rc=$rc notes=$n $out"

  # weekly-wiki-check.sh: clean on a tidy wiki, needs attention with a broken link, refused where there is no wiki
  T="$SB/tidy$L"; mkagent "$T" "$L" kitwiki
  out="$(CLAUDE_PROJECT_DIR="$T" bash "$T/scripts/weekly-wiki-check.sh" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" head -1 | grep -q '^clean:'; } && ok "layout $L: weekly-wiki-check.sh says clean on a tidy wiki" || no "layout $L: weekly-wiki-check.sh on a tidy wiki (rc=$rc)" "$out"
  printf -- '---\ntitle: A\ntype: note\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\nSee [[nowhere-at-all]].\n' > "$T/$WREL/a.md"
  out="$(CLAUDE_PROJECT_DIR="$T" bash "$T/scripts/weekly-wiki-check.sh" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" head -1 | grep -q '^needs attention:' && <<<"$out" grep -q 'nowhere-at-all'; } && ok "layout $L: weekly-wiki-check.sh says needs attention for a broken link" || no "layout $L: weekly-wiki-check.sh on a broken wiki (rc=$rc)" "$out"
  rm -rf "$T/$WREL"
  out="$(CLAUDE_PROJECT_DIR="$T" bash "$T/scripts/weekly-wiki-check.sh" 2>&1)"; rc=$?
  { [ "$rc" = 1 ] && <<<"$out" grep -q 'not a Talos agent folder'; } && ok "layout $L: a folder with no wiki is refused with exit 1" || no "layout $L: weekly-wiki-check.sh with no wiki (rc=$rc)" "$out"
done

# ---------------------------------------------------------------------------------------------------- strict layout lines
# Every copy of the rule (the resolver, and the three standalone hook copies) must give the same answer for the same
# .talos-version, odd ones included: a BOM is ignored; a second layout line, a misspelt one (Layout=2, layout: 2) or a bad value
# is refused, never guessed; no layout line is layout 1.
echo "== strict layout lines (every copy of the rule agrees)"
A="$SB/agent1"
# The check is written to a file first: macOS's /bin/bash 3.2 cannot parse a heredoc holding parentheses inside <( ... ).
cat > "$SB/strict.py" <<'PY'
import importlib.util, os, sys
A, SB = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(A, "hooks")); sys.path.insert(0, os.path.join(A, "scripts"))
try:
    import _talos_common as C, _talos_session as S, _talos_layout as T
    spec = importlib.util.spec_from_file_location("ss", os.path.join(A, "hooks", "session-start.py"))
    ss = importlib.util.module_from_spec(spec); spec.loader.exec_module(ss)
    copies = [("resolver", lambda d: T.paths(d)["wiki"]), ("_talos_common", C.wiki_dir), ("_talos_session", S.wiki_dir), ("session-start", ss.wiki_dir)]
except Exception as e:
    print("FAIL could not load the copies: %r" % (e,)); sys.exit(0)
BOM = b"\xef\xbb\xbf"
cases = [("no file", None, 1), ("version only", b"version=1.2.0-cli\n", 1), ("layout=1", b"layout=1\n", 1), ("layout=2", b"layout=2\n", 2),
         ("layout = 2 (spaces)", b"version=x\nlayout = 2\n", 2), ("BOM + layout=2", BOM + b"layout=2\n", 2),
         ("BOM + version line + layout=2", BOM + b"version=x\nlayout=2\n", 2), ("layout_note=hi is no layout line", b"layout_note=hi\n", 1),
         ("Layout=2 refused", b"Layout=2\n", 0), ("layout: 2 refused", b"layout: 2\n", 0), ("layout=zz refused", b"layout=zz\n", 0),
         ("layout=1 then layout=zz refused", b"layout=1\nlayout=zz\n", 0), ("layout=2 then layout=3 refused", b"layout=2\nlayout=3\n", 0),
         ("layout=1 twice refused", b"layout=1\nlayout=1\n", 0), ("layout=2 then Layout=2 refused", b"layout=2\nLayout=2\n", 0)]
for name, data, want in cases:
    d = os.path.join(SB, "case"); os.makedirs(d, exist_ok=True)
    p = os.path.join(d, ".talos-version")
    if data is None:
        if os.path.exists(p): os.remove(p)
    else:
        open(p, "wb").write(data)
    expect = {1: os.path.join(d, "wiki"), 2: os.path.join(d, "memory", "wiki"), 0: "refused"}[want]
    got = []
    for cname, fn in copies:
        try:
            w = fn(d)
        except SystemExit as e:
            w = "refused" if "unknown layout" in str(e) else "BAD MESSAGE: %s" % e
        got.append((cname, w))
    bad = [c + "=" + str(w) for c, w in got if w != expect]
    print(("ok " + name) if not bad else "FAIL %s: want %s, got %s" % (name, expect, "; ".join(bad)))
PY
strict_out="$(cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 "$SB/strict.py" "$A" "$SB" 2>&1)"; strict_rc=$?
[ "$strict_rc" = 0 ] || no "the strict layout-line check exited $strict_rc" "$strict_out"
while IFS= read -r line; do
  case "$line" in
    "ok "*)   ok "layout line: ${line#ok }" ;;
    "FAIL "*) no "layout line: ${line#FAIL }" ;;
    *)        no "layout line harness said: $line" ;;
  esac
done <<<"$strict_out"
mkdir -p "$SB/case"
printf 'layout=1\nlayout=zz\n' > "$SB/case/.talos-version"
out="$(python3 "$A/scripts/_talos_layout.py" "$SB/case" wiki 2>&1 >/dev/null)"; rc=$?
{ [ "$rc" = 1 ] && <<<"$out" grep -q 'more than one layout line'; } && ok "a second layout line is refused with the message 'more than one layout line'" || no "second layout line message (rc=$rc)" "$out"

# ---------------------------------------------------------------------------------------------------- per layout, round two
for L in 1 2; do
  A="$SB/agent$L"; if [ "$L" = 2 ]; then WREL="memory/wiki"; else WREL="wiki"; fi
  echo "== layout $L, more consumers (wiki at $WREL/)"

  # weekly-snapshot.sh commits the wiki and memory changes. On layout 1 a python3 that always fails must not matter: no
  # layout line, no resolver.
  S="$SB/snap$L"; mkagent "$S" "$L"
  ( cd "$S" && git init -q && git config user.email t@example.com && git config user.name t && git add -A && git commit -q -m init ) >/dev/null 2>&1
  printf 'more text\n' >> "$S/$WREL/concepts/zorptastic-widgets.md"; printf 'more log\n' >> "$S/memory/2026-03-02.md"
  mkdir -p "$SB/stub"; printf '#!/bin/sh\nexit 1\n' > "$SB/stub/python3"; chmod +x "$SB/stub/python3"
  if [ "$L" = 1 ]; then SNAPPATH="$SB/stub:$PATH"; WHY="with a python3 that always fails"; else SNAPPATH="$PATH"; WHY=""; fi
  out="$( cd "$S" && PATH="$SNAPPATH" bash scripts/weekly-snapshot.sh 2>&1 )"; rc=$?
  files="$(cd "$S" && git show --name-only --format= HEAD 2>/dev/null)"
  { [ "$rc" = 0 ] && <<<"$out" grep -q 'snapshot: committed' && <<<"$files" grep -qx "$WREL/concepts/zorptastic-widgets.md" && <<<"$files" grep -qx 'memory/2026-03-02.md'; } \
    && ok "layout $L: weekly-snapshot.sh commits the changes under $WREL/ and memory/ $WHY" || no "layout $L: weekly-snapshot.sh $WHY (rc=$rc)" "$out | $files"

  # verify-install.sh grades the wiki of this layout
  out="$(cd "$A" && CLAUDE_PROJECT_DIR="$A" bash scripts/verify-install.sh 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
  { <<<"$out" grep -q "PASS  $WREL/me.md has frontmatter" && <<<"$out" grep -q "PASS  $WREL/_onboarding-progress.md"; } \
    && ok "layout $L: verify-install.sh reads $WREL/me.md and $WREL/_onboarding-progress.md" || no "layout $L: verify-install.sh did not grade $WREL/" "$(printf '%s' "$out" | grep -i 'wiki' | head -5)"

  # wiki-gazetteer.py indexes the notes of this wiki
  out="$(cd "$A" && python3 scripts/wiki-gazetteer.py --out "$SB/gaz$L.json" --quiet 2>&1)"
  got="$(python3 -c 'import json,sys; print(" ".join(sorted(n["p"] for n in json.load(open(sys.argv[1]))["notes"] if "dana-ruiz" in n["p"])))' "$SB/gaz$L.json" 2>&1)"
  [ "$got" = "$WREL/people/dana-ruiz.md" ] && ok "layout $L: wiki-gazetteer.py lists $WREL/people/dana-ruiz.md" || no "layout $L: wiki-gazetteer.py gave '$got'" "$out"
done

# ---------------------------------------------------------------------------------------------------- a layout line nobody can read
# With layout=3 neither guard may go quiet or deaf: the append-only files stay protected (the daily logs, without any layout
# lookup; the wiki changelog in BOTH places it could be), and the timeline guard judges BOTH candidate wiki folders and lets
# everything else through. Unattended, as the Chronos jobs run them.
echo "== layout=3: the guards keep guarding"
B="$SB/bad3"; mkagent "$B" 1; printf 'version=1.2.0-cli\nlayout=3\n' > "$B/.talos-version"
mkdir -p "$B/wiki/people" "$B/memory/wiki/people"
python3 -c 'print("log line of some length\n" * 150)' > "$B/memory/2026-01-01.md"
for w in wiki memory/wiki; do cp "$SB/agent1/wiki/_changelog.md" "$B/$w/_changelog.md"; done
WRITE() { python3 -c 'import json,sys; print(json.dumps({"tool_name":"Write","tool_input":{"file_path":sys.argv[1],"content":sys.argv[2]}}))' "$@"; }
for f in memory/2026-01-01.md wiki/_changelog.md memory/wiki/_changelog.md; do
  out="$(WRITE "$B/$f" x | ( cd "$B" && python3 hooks/append-only-guard.py 2>&1 ))"
  <<<"$out" grep -q '"ask"' && ok "layout=3: append-only-guard still asks before shrinking $f (live session)" || no "layout=3: append-only-guard let a shrinking write to $f through (live session)" "$out"
  out="$(WRITE "$B/$f" x | ( cd "$B" && CHRONOS_RUN=1 python3 hooks/append-only-guard.py 2>&1 ))"
  <<<"$out" grep -q 'would SHRINK' && <<<"$out" grep -q '"deny"' && ok "layout=3: append-only-guard refuses to shrink $f (unattended, for the right reason)" || no "layout=3: append-only-guard did not refuse $f for the shrink (unattended)" "$out"
done
BADNOTE="$(printf -- '---\ntitle: N\n---\n# N\n[[a]] [[b]]\n%s\n- **2026-09-23** | this transcript | @me -- Coached Pat\nwhile she deleted the classes. Confidence: high\n' "$SEP")"
out="$(WRITE "$B/notes.txt" "hello" | ( cd "$B" && CHRONOS_RUN=1 python3 hooks/timeline-guard.py 2>&1 ))"
[ "$(printf '%s' "$out" | tr -d '[:space:]')" = '{}' ] && ok "layout=3: timeline-guard allows a write outside both wiki folders (notes.txt)" || no "layout=3: timeline-guard did not allow notes.txt" "$out"
for f in wiki/people/new.md memory/wiki/people/new.md; do
  out="$(WRITE "$B/$f" "$BADNOTE" | ( cd "$B" && CHRONOS_RUN=1 python3 hooks/timeline-guard.py 2>&1 ))"
  <<<"$out" grep -q 'ONE physical line' && <<<"$out" grep -q '"deny"' && ok "layout=3: timeline-guard denies the bad entry under $f" || no "layout=3: timeline-guard let a bad entry under $f through" "$out"
done

# ---------------------------------------------------------------------------------------------------- stray folders, lone copies
echo "== a stray top-level wiki/ on layout 2, and a lone copy"
Z="$SB/stray2"; mkagent "$Z" 2; mkdir -p "$Z/wiki"; printf '# Stray\nstraynote lives in the wrong place.\n' > "$Z/wiki/stray.md"
got="$(cd "$Z" && python3 - "$Z" <<'PY' 2>&1
import os, sys
Z = sys.argv[1]
sys.path.insert(0, os.path.join(Z, "scripts", "memory")); sys.path.insert(0, os.path.join(Z, "scripts"))
import corpus
dirs = corpus.corpus_dirs(Z)
files = [os.path.relpath(p, Z) for p in corpus.source_files(Z)]
mine = [f for f in files if f == "memory/wiki/concepts/zorptastic-widgets.md"]
stray = [f for f in files if f.startswith("wiki/")]
print("dirs=%s once=%d stray=%d" % ("+".join(dirs), len(mine), len(stray)))
PY
)"
[ "$got" = "dirs=memory+.learnings once=1 stray=0" ] && ok "layout 2: the corpus covers memory/wiki once and ignores a stray top-level wiki/" || no "layout 2 corpus with a stray wiki/" "$got"
Y="$SB/lone"; mkagent "$Y" 1; rm -f "$Y/scripts/_talos_layout.py"
out="$(cd "$Y" && bash scripts/wiki-search.sh zorptastic 2>&1)"
<<<"$out" grep -q '^  wiki/concepts/zorptastic-widgets.md$' && ok "a lone scripts/ copy without _talos_layout.py still searches a layout-1 wiki" || no "lone copy of wiki-search.sh" "$out"

echo "layout: PASS $PASS FAIL $FAIL"
[ "$FAIL" = 0 ]
