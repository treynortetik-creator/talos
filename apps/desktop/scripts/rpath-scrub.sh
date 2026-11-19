#!/usr/bin/env bash
# rpath-scrub.sh <Mach-O>: deletes every LC_RPATH that points into an Xcode toolchain or under $HOME (any slice of a universal
# file; install_name_tool edits each), keeps the rest (/usr/lib/swift, @loader_path, @executable_path...). Prints what it took out.
# Exit 0 done (also when there was nothing to take out), 1 a step failed or such an rpath is still there, 64 bad use.
set -euo pipefail
F="${1:-}"
[ -n "$F" ] && [ -f "$F" ] || { echo "rpath-scrub: usage: rpath-scrub.sh <Mach-O file>" >&2; exit 64; }
bad() { # the rpaths to take out, one per line, unique
  /usr/bin/otool -l "$F" | /usr/bin/awk '/cmd LC_RPATH/{r=1; next} r && /path /{sub(/^ *path /,""); sub(/ \(offset [0-9]+\)$/,""); print; r=0}' |
    while IFS= read -r p; do
      case "$p" in
        *.xctoolchain/*|*/Xcode*.app/*|*/CommandLineTools/*) printf '%s\n' "$p" ;;
        *) if [ -n "${HOME:-}" ] && [ "$HOME" != "/" ]; then case "$p" in "$HOME"/*) printf '%s\n' "$p" ;; esac; fi ;;
      esac
    done | sort -u
}
while IFS= read -r p; do
  [ -n "$p" ] || continue
  # one -delete_rpath removes it from every slice that has it; repeat while any slice still lists it
  for _ in 1 2 3 4; do
    /usr/bin/otool -l "$F" | grep -qF "path $p (" || break
    /usr/bin/install_name_tool -delete_rpath "$p" "$F" 2>/dev/null || break
  done
  echo "rpath-scrub: took out an rpath into the build Mac's toolchain or home folder"
done < <(bad)
[ -z "$(bad)" ] || { echo "rpath-scrub: an rpath into the build Mac's toolchain or home folder is still in the file" >&2; exit 1; }
