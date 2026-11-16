#!/usr/bin/env bash
# File names compared the way a Mac's disk compares them. APFS (and HFS+) treat two names as the same file when they differ
# only in letter case, Unicode case included (the Kelvin sign U+212A is a "k" there, the long s U+017F an "s"), or in
# composition (an "é" as one code point or as "e" plus an accent). So a new file "Scripts/x.sh" or "apps/new/pac<U+212A>age.json"
# is, on the landing Mac, scripts/x.sh or a package.json: a byte-for-byte or ASCII-only (grep -i) match misses it. Here every
# name is folded first (NFC, full Unicode case folding, invisible code points dropped), in ONE node process for the whole list.
# Folding more than the disk does only ever refuses more: every caller treats a hit as "refused" or "the full gate".
#
#   . scripts/path-fold.sh
#   path_fold inputs <patterns file> < <NUL-separated names>   the names that match a line of the patterns file (gate-inputs.txt:
#                                                              one extended regex per line, # comments), the first one printed
#   path_fold same <NUL-separated names file> < <NUL-separated names>
#                                                              the first name on stdin that is, folded, a name in the file
# Exit: 0 a hit (its name on stdout), 1 none, 3 a name with a newline (it cannot be one line: refuse), 2 anything else (no
# node of the repo's major, a pattern that does not compile, node failing in any way). Only 1 means "no hit": callers refuse
# on anything else.

# The repo's Node, picked the way gate.sh picks it: node on PATH when its major is the one .nvmrc names (or there is no .nvmrc),
# else the first of Homebrew's node@N and nvm's that has that major. None: return 1 (the caller fails closed).
path_fold_node() {
  local want have d
  command -v node >/dev/null 2>&1 || [ -f .nvmrc ] || return 1
  want=""
  [ ! -f .nvmrc ] || want="$(head -1 .nvmrc | sed 's/^v//; s/\..*//' | tr -dc '0-9')"
  have="$(env -u NODE_OPTIONS node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  if [ -z "$want" ] || [ "$have" = "$want" ]; then
    [ -n "$have" ] || return 1
    command -v node
    return 0
  fi
  for d in "/opt/homebrew/opt/node@$want/bin" "/usr/local/opt/node@$want/bin" "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*/bin; do
    [ -x "$d/node" ] || continue
    [ "$(env -u NODE_OPTIONS "$d/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "$want" ] || continue
    printf '%s\n' "$d/node"
    return 0
  done
  return 1
}

# The status is the first line node prints ("hit", "none", "newline"); exit 0 and a known status, or it is an error. A node
# that dies, a syntax error in this program, an exception: none of them can read as "none".
PATH_FOLD_JS='
const fs = require("node:fs")
const out = (s) => { process.stdout.write(s); process.exit(0) }
try {
  const [mode, file] = process.argv.slice(1)
  const names = (buf) => { const a = buf.toString("utf8").split("\0"); if (a[a.length - 1] === "") a.pop(); return a }
  const fold = (s) => s.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC").replace(/\p{Default_Ignorable_Code_Point}/gu, "")
  const list = names(fs.readFileSync(0))
  if (list.some((n) => n.includes("\n"))) out("newline\n")
  let hit
  if (mode === "inputs") {
    const pats = fs.readFileSync(file, "utf8").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "" && !l.startsWith("#"))
    if (pats.length === 0) throw new Error("no patterns")
    const res = pats.map((p) => new RegExp(p, "iu"))
    hit = list.find((n) => { const f = fold(n); return res.some((r) => r.test(n) || r.test(f)) })
  } else if (mode === "same") {
    const mine = new Set(names(fs.readFileSync(file)).map(fold))
    hit = list.find((n) => mine.has(fold(n)))
  } else throw new Error("unknown mode")
  out(hit === undefined ? "none\n" : `hit\n${hit}\n`)
} catch (e) { process.stderr.write(`path-fold: ${e && e.message}\n`); process.exit(2) }
'

path_fold() { # path_fold <inputs|same> <file>, NUL-separated names on stdin
  local node out rc
  node="$(path_fold_node)" || { echo "path-fold: no node of this repo's major (.nvmrc) to compare file names with" >&2; return 2; }
  out="$(env -u NODE_OPTIONS -u NODE_PATH "$node" -e "$PATH_FOLD_JS" -- "$1" "$2")"
  rc=$?
  [ "$rc" = 0 ] || return 2
  case "$out" in
    none) return 1 ;;
    newline) return 3 ;;
    hit$'\n'?*) printf '%s\n' "${out#hit$'\n'}" ;;
    *) return 2 ;;
  esac
}

# path_fold_git <patterns file> <git command...>: the NUL-separated names a git command prints (it must print with -z), matched
# as `path_fold inputs` matches them. The names go through a temp file, never a pipe: with pipefail a git that failed and a
# matcher that said "none" would read as "none" (fail open). Exit as path_fold; git failing is 2.
path_fold_git() {
  local tmp rc
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/path-fold.XXXXXX")" || return 2
  # the patterns copied first: a caller's <(...) is gone once the first command here (git) has run (bash closes it)
  if ! cat "$1" >"$tmp/pats" 2>/dev/null || [ ! -s "$tmp/pats" ]; then
    rm -rf "$tmp"
    return 2
  fi
  shift
  if ! git "$@" >"$tmp/names" 2>/dev/null; then
    rm -rf "$tmp"
    return 2
  fi
  path_fold inputs "$tmp/pats" <"$tmp/names"
  rc=$?
  rm -rf "$tmp"
  return "$rc"
}

# path_fold_range <patterns file> <range>: every name ANY commit of the range touches (a merge against each of its parents),
# not the net diff of the range: a file a side commit changes and a later commit (or a merge) puts back is in the range all the
# same, and a rebase that replays that side commit puts it on disk. Exit as path_fold.
path_fold_range() {
  path_fold_git "$1" log -z --name-only --format= --no-renames -m "$2" --
}
