// A fake GitHub for scripts/lead-inbox.sh's tests: a `gh` that keeps issues and comments as JSON files in a state folder and runs
// the caller's own --jq over them with the real jq, so the script's filters are the ones under test. Never the real GitHub.
//   <state>/visibility   what `gh repo view --json visibility` says (default PRIVATE)
//   <state>/issues.json  the issues; <state>/comments-<n>.json each issue's comments
//   <state>/fail-read    every read fails; <state>/fail-post  posting a comment fails (exit 1, as gh does on an HTTP error)
//   <state>/slow-read    reading the comments takes a second more (widens a race between two callers)
//   <state>/calls        one line per call: the method and the path
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function fakeGh(bin: string, state: string): void {
  mkdirSync(bin, { recursive: true })
  mkdirSync(state, { recursive: true })
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
S='${state}'
q="" method=GET path="" fields=()
if [ "$1" = repo ]; then
  echo "GET repo-view" >> "$S/calls"
  [ ! -f "$S/fail-read" ] || exit 1
  while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
  v="$(cat "$S/visibility" 2>/dev/null || echo PRIVATE)"
  printf '{"visibility":"%s"}' "$v" | jq -r "\${q:-.}"
  exit
fi
[ "$1" = api ] || { echo "fake gh: only api and repo view" >&2; exit 2; }
shift
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    --jq) q="$2"; shift ;;
    -f) fields+=("$2"); shift ;;
    --paginate) ;;
    -*) echo "fake gh: unknown flag $1" >&2; exit 2 ;;
    *) path="$1" ;;
  esac
  shift
done
echo "$method \${path%%\\?*}" >> "$S/calls"
field() { local f; for f in "\${fields[@]}"; do [ "\${f%%=*}" = "$1" ] && { printf '%s' "\${f#*=}"; return; }; done; }
out() { jq -r "\${q:-.}"; }
[ -f "$S/issues.json" ] || echo '[]' > "$S/issues.json"
case "$method $path" in
  "GET "repos/*/issues\\?labels=*)
    [ ! -f "$S/fail-read" ] || exit 1
    l="\${path#*labels=}" l="\${l%%&*}"
    jq --arg l "$l" '[.[] | select(any(.labels[]; .name == $l))]' "$S/issues.json" | out ;;
  "POST "repos/*/labels) touch "$S/label-$(field name)"; echo '{}' | out ;;
  "POST "repos/*/issues)
    n=$(($(jq length "$S/issues.json") + 1))
    jq --argjson n "$n" --arg t "$(field title)" --arg l "$(field 'labels[]')" \\
      '. + [{number: $n, title: $t, labels: [{name: $l}]}]' "$S/issues.json" > "$S/i.part" && mv "$S/i.part" "$S/issues.json"
    echo '[]' > "$S/comments-$n.json"
    printf '{"number":%s}' "$n" | out ;;
  "GET "repos/*/issues/*/comments*)
    [ ! -f "$S/fail-read" ] || exit 1
    n="\${path#*/issues/}" n="\${n%%/*}"
    [ -f "$S/comments-$n.json" ] || { echo "HTTP 404" >&2; exit 1; }
    out < "$S/comments-$n.json"
    [ ! -f "$S/slow-read" ] || sleep 1 ;; # a slow GitHub: two callers both read before either posts
  "POST "repos/*/issues/*/comments)
    [ ! -f "$S/fail-post" ] || { echo "HTTP 502" >&2; exit 1; }
    n="\${path#*/issues/}" n="\${n%%/*}"
    [ -f "$S/comments-$n.json" ] || { echo "HTTP 404" >&2; exit 1; }
    id=$((1000 + 7 * $(jq length "$S/comments-$n.json")))
    jq --argjson id "$id" --arg b "$(field body)" '. + [{id: $id, body: $b}]' "$S/comments-$n.json" > "$S/c.part" && mv "$S/c.part" "$S/comments-$n.json"
    printf '{"id":%s}' "$id" | out ;;
  *) echo "fake gh: no such call: $method $path" >&2; exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
}

/** The comments on issue n of a fake GitHub's state folder (none when it has no such issue). */
export function comments(state: string, n = 1): { id: number; body: string }[] {
  const f = join(state, `comments-${n}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
}

/** The issues of a fake GitHub's state folder. */
export function issues(state: string): { number: number; title: string; labels: { name: string }[] }[] {
  const f = join(state, 'issues.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
}
